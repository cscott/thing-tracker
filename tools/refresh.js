#!/usr/bin/env node
/**
 * Thing index updater.
 */
'use strict';

var argv = require('yargs')
    .option('file', { alias: 'f', describe: 'a JSON thing description' })
    .option('readme', { alias: 'r', describe: 'a README.md with thing info.' })
    .option('base', { alias: 'b', describe: 'Base URL for thing-local paths.' })
    .demandOption(['file'], 'A thing description is required')
    .help()
    .argv;
var validator = require('is-my-json-valid');
var fs = require('fs');
var process = require('process');
var path = require('path');
var rimraf = require('rimraf');
var mkdirp = require('mkdirp');
var cp = require('cp');
var isRelativeUrl = require('is-relative-url');
var URL = require('dom-urls'); // built-in in node >= 7.0.0

var StlThumbnailer = require('node-stl-thumbnailer');
var domino = require('domino');
var marked = require('marked');
var spdxParse = require('spdx-expression-parse');

var trackerPath = path.join(__dirname, '..', 'tracker.json');
var trackerSchema = require('./schema.json');

var mimeTypes = {
    pdf: 'application/pdf',
    stl: 'application/sla',
    scad: 'application/x-scad',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    txt: 'text/plain',
    md: 'text/plain',
};

var readJSON = function(file, schema) {
    var str, json;
    try {
        str = fs.readFileSync(file, 'utf8');
    } catch (e) {
        console.error('Could not read: ' + file);
        process.exit(1);
    }
    try {
        json = JSON.parse(str);
    } catch (e) {
        console.error('Could not parse as JSON: ' + file);
        process.exit(1);
    }
    var validate = validator(schema);
    if (!validate(json, { verbose: true, greedy: true })) {
        console.error('JSON is not valid: ' + file);
        console.error(validate.errors);
        process.exit(1);
    }
    return json;
};

var tracker = readJSON(trackerPath, trackerSchema);
var thing = readJSON(argv.file, trackerSchema.properties.things.items);
var done = Promise.resolve();

// Guess about base URL
var baseURL = argv.base;
var githubBaseURL;
if (!baseURL) {
    var m = /^https?:\/\/github.com\/([^\/]+)\/([^\/]+)\/?$/.exec(thing.url);
    if (m) {
        //baseURL = 'https://' + m[1] + '.github.io/' + m[2] + '/';
        baseURL = 'https://github.com/' + m[1] + '/' + m[2] + '/raw/master/';
        githubBaseURL = 'https://github.com/' + m[1] + '/' + m[2] + '/blob/master/';
    }
}
if (!baseURL) {
    console.error('Unable to guess base URL.');
    process.exit(2);
}
if (!/\/$/.test(baseURL)) { baseURL += '/'; }

var addBaseURL = function(s, otherBase) {
    var u = new URL(s, otherBase || baseURL);
    return u.href;
};

// Fill in thing.json based on a README.

var extractSectionHtml = function(doc, hSelect, reTest) {
    var sectDoc = extractSectionDoc(doc, hSelect, reTest);
    if (sectDoc) {
        return stripWS(sectDoc.body.innerHTML);
    }
    return null;
};

var extractSectionDoc = function(doc, hSelect, reTest) {
    var resultDoc = domino.createDocument('', true);
    var matches = doc.querySelectorAll(hSelect);
    for (var i=0; i<matches.length; i++) {
        var m = matches[i];
        if (reTest ? reTest.test(m.textContent) : true) {
            var stop = Object.create(null);
            for (var i = 1; i <= 6; i++) {
                var h = 'H' + i;
                stop[h] = true;
                if (h === m.nodeName) { break; }
            }
            for (var n = m.nextSibling; n && !stop[n.nodeName]; n = n.nextSibling) {
                resultDoc.body.appendChild(resultDoc.importNode(n, true));
            }
            return resultDoc;
        }
    }
    return null; // no match
}

var isValidSpdx = function(txt) {
    try {
        spdxParse(txt);
        return true;
    } catch (e) {
        return false;
    }
};

var removeEls = function(doc, selector) {
    Array.from(doc.querySelectorAll(selector)).forEach(function(n) {
        n.remove();
    });
};

var adjustLinks = function(doc) {
    var adjOne = function(el, attrName) {
        var val = el.getAttribute(attrName);
        if (isRelativeUrl(val)) {
            // link to github page for STL file previewer
            if (/\.stl$/.test(val)) {
                el.setAttribute(attrName, addBaseURL(val, githubBaseURL));
            } else {
                el.setAttribute(attrName, addBaseURL(val));
            }
        }
    };
    Array.from(doc.querySelectorAll('a[href]')).forEach(function(a) {
        adjOne(a, 'href');
    });
    Array.from(doc.querySelectorAll('img[src]')).forEach(function(img) {
        adjOne(img, 'src');
    });
};

var stripWS = function(s) {
    return s.replace(/(^\s+)|(\s+$)/g, '');
};

if (argv.readme) {
    marked.setOptions({ smartypants: true });
    var doc = domino.createDocument(
        marked(fs.readFileSync(argv.readme, 'utf8')), true
    );
    // description
    var descDoc = extractSectionDoc(doc, 'h2#description');
    if (descDoc !== null) {
        removeEls(descDoc, 'img[align], br[clear], p:empty');
        adjustLinks(descDoc);
        thing.description = stripWS(descDoc.body.innerHTML);
    }
    // license
    var licenseDoc = extractSectionDoc(doc, 'h2#license');
    if (licenseDoc) {
        var l = [];
        Array.from(licenseDoc.querySelectorAll('a[href]')).forEach(function(a) {
            var m = /^https?:\/\/spdx\.org\/licenses\/(.*)\.html$/.exec(a.href);
            if (a.textContent && isValidSpdx(a.textContent)) {
                l.push(a.textContent);
            } else if (m && isValidSpdx(m[1])) {
                l.push(m[1]);
            }
        });
        thing.licenses = l;
    }
    // instructions
    var instructDoc = extractSectionDoc(doc, 'h2#instructions');
    if (instructDoc) {
        var i = [];
        Array.from(instructDoc.querySelectorAll('h3')).forEach(function(h3) {
            var chunk = extractSectionDoc(doc, 'h3#' + h3.id);
            var title = stripWS(h3.textContent.replace(/Step\s+\d+[:.]?/, ''));
            var images = [];
            Array.from(chunk.querySelectorAll('img[align]')).forEach(function(img) {
                var src = img.getAttribute('src');
                if (/^\.\//.test(src)) {
                    images.push(src.slice(2));
                }
            });
            // Mutate instruction HTML
            removeEls(chunk, 'img[align], br[clear], p:empty');
            if (title) {
                var b = chunk.createElement('b');
                b.textContent = title;
                chunk.body.insertBefore(chunk.createElement('br'), chunk.body.firstChild);
                chunk.body.insertBefore(b, chunk.body.firstChild);
            }
            adjustLinks(chunk);
            i.push({
                step: i.length + 1,
                text: stripWS(chunk.body.innerHTML),
                images: images.length ? images : undefined
            });
        });
        thing.instructions = i;
    }
    // "related" / "relationships"
    var relatedDoc = extractSectionDoc(doc, 'h2#related');
    if (relatedDoc) {
        var r = [];
        Array.from(relatedDoc.querySelectorAll('li')).forEach(function(li) {
            var a = li.querySelectorAll('a');
            if (a.length === 1) {
                r.push({
                    type: "reference",
                    url: a[0].href,
                    title: stripWS(li.textContent)
                });
            }
        });
        thing.relationships = r;
    }
}

// Adjust mimetypes in BOM
(thing.billOfMaterials || []).forEach(function(bom) {
    if (!bom.mimetype) {
        var m = /\.([^.])+$/.exec(bom.url);
        if (m && mimeTypes[m[1]]) {
            bom.mimetype = mimeTypes[m[1]];
        }
    }
});


// Copy over thumbnails
var thumbPath = path.join(__dirname, '..', 'thumbnails', thing.id);
var thumbMap = new Map();
var mapArrayUrls = function(arr, alsoLocal) {
    for (var i=0; i<arr.length; i++) {
        if (thumbMap.has(arr[i])) {
            arr[i] = thumbMap.get(arr[i]);
        } else if (alsoLocal && isRelativeUrl(arr[i])) {
            arr[i] = addBaseURL(arr[i]);
        }
    }
};
var mapFieldUrls = function(obj, props, alsoLocal) {
    for (var i=0; i<props.length; i++) {
        if (thumbMap.has(obj[props[i]])) {
            obj[props[i]] = thumbMap.get(obj[props[i]]);
        } else if (alsoLocal && isRelativeUrl(obj[props[i]])) {
            obj[props[i]] = addBaseURL(obj[props[i]]);
        }
    }
};
rimraf.sync(thumbPath, { disableGlob: true });
if ((thing.thumbnailUrls || []).length) {
    thing.thumbnailUrls.forEach(function(url) {
        if (!isRelativeUrl(url)) { return; }
        var wasPath = path.join(path.dirname(argv.file), url);
        mkdirp.sync(path.join(thumbPath, path.dirname(url)));
        cp.sync(wasPath, path.join(thumbPath, url));
        var newPath = 'thumbnails/' + thing.id + '/' + url;
        thumbMap.set(url, newPath);
    });
} else { thing.thumbnailUrls = []; }

// Create some thumbnails automatically.
(thing.billOfMaterials || []).forEach(function(bom) {
    if (!bom.thumbnailUrl && isRelativeUrl(bom.url)) {
        // generate some preview images automatically
        var url = bom.url; // because it will change!
        var newPath = 'thumbnails/' + thing.id + '/' + url + '.png';
        // XXX check if this already exists, rename if so.
        if (bom.mimetype === 'application/sla') {
            mkdirp.sync(path.join(thumbPath, path.dirname(url)));
            bom.thumbnailUrl = newPath;
            thing.thumbnailUrls.push(newPath);
            done = done.then(function() {
                return new StlThumbnailer({
                    filePath: path.join(path.dirname(argv.file), url),
                    requestThumbnails: [ { width: 500, height: 500 } ]
                }).then(function(thumbnails) {
                    var buf = thumbnails[0].toBuffer();
                    fs.writeFileSync(
                        path.join(__dirname, '..', newPath), buf
                    );
                });
            });
        }
    }
});

mapArrayUrls(thing.thumbnailUrls || []);
(thing.billOfMaterials || []).forEach(function(bom) {
    mapFieldUrls(bom, ['url', 'thumbnailUrl']);
});
(thing.instructions || []).forEach(function(instruct) {
    mapArrayUrls(instruct.images || [], true);
});

(thing.billOfMaterials || []).forEach(function(bom) {
    if (isRelativeUrl(bom.url)) {
        if (bom.mimetype === 'application/sla' && githubBaseURL) {
            // link to github page for STL file previewer
            bom.url = addBaseURL(bom.url, githubBaseURL);
        } else {
            // direct download
            bom.url= addBaseURL(bom.url);
        }
    }
});

// Update Tracker JSON!
var i;
for (i = 0; i<tracker.things.length; i++) {
    if (tracker.things[i].id === thing.id)
        break;
}
tracker.things[i] = thing;
tracker.thingsCount = tracker.things.length;
tracker.updated = thing.updated = new Date().toISOString();
fs.writeFileSync(trackerPath, JSON.stringify(tracker, null, 4));
done = done.then(function() { process.exit(0); });
