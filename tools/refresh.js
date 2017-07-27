#!/usr/bin/env node
/**
 * Thing index updater.
 */
'use strict';

var argv = require('yargs')
    .option('file', { alias: 'f', describe: 'a JSON thing description' })
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
var StlThumbnailer = require('node-stl-thumbnailer');

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

var isLocal = function(url) {
    return ! /^https?:/.test(url);
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

// Adjust links to BOM
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
var mapArrayUrls = function(arr) {
    for (var i=0; i<arr.length; i++) {
        if (thumbMap.has(arr[i])) {
            arr[i] = thumbMap.get(arr[i]);
        }
    }
};
var mapFieldUrls = function(obj, props) {
    for (var i=0; i<props.length; i++) {
        if (thumbMap.has(obj[props[i]])) {
            obj[props[i]] = thumbMap.get(obj[props[i]]);
        }
    }
};
rimraf.sync(thumbPath, { disableGlob: true });
if ((thing.thumbnailUrls || []).length) {
    thing.thumbnailUrls.forEach(function(url) {
        if (!isLocal(url)) { return; }
        var wasPath = path.join(path.dirname(argv.file), url);
        mkdirp.sync(path.join(thumbPath, path.dirname(url)));
        cp.sync(wasPath, path.join(thumbPath, url));
        var newPath = 'thumbnails/' + thing.id + '/' + url;
        thumbMap.set(url, newPath);
    });
} else { thing.thumbnailUrls = []; }

// Create some thumbnails automatically.
(thing.billOfMaterials || []).forEach(function(bom) {
    if (!bom.thumbnailUrl && isLocal(bom.url)) {
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
    mapArrayUrls(instruct.images || []);
});

(thing.billOfMaterials || []).forEach(function(bom) {
    if (isLocal(bom.url)) {
        if (bom.mimetype === 'application/sla' && githubBaseURL) {
            // link to github page for STL file previewer
            bom.url = githubBaseURL + bom.url;
        } else {
            // direct download
            bom.url= baseURL + bom.url;
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
