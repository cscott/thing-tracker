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

var trackerPath = path.join(__dirname, '..', 'tracker.json');
var trackerSchema = require('./schema.json');

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

// Guess about base URL
var baseURL = argv.base;
if (!baseURL) {
    var m = /^https?:\/\/github.com\/([^\/]+)\/([^\/]+)\/?$/.exec(thing.url);
    if (m) {
        //baseURL = 'https://' + m[1] + '.github.io/' + m[2] + '/';
        baseURL = 'https://github.com/' + m[1] + '/' + m[2] + '/raw/master/';
    }
}
if (!baseURL) {
    console.error('Unable to guess base URL.');
    process.exit(2);
}
if (!/\/$/.test(baseURL)) { baseURL += '/'; }

// Adjust links to BOM
(thing.billOfMaterials || []).forEach(function(bom) {
    if (!/^http/.test(bom.url)) {
        bom.url= baseURL + bom.url;
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
        if (/^http/.test(url)) { return; }
        var wasPath = path.join(path.dirname(argv.file), url);
        mkdirp.sync(path.join(thumbPath, path.dirname(url)));
        cp.sync(wasPath, path.join(thumbPath, url));
        var newPath = 'thumbnails/' + thing.id + '/' + url;
        thumbMap.set(url, newPath);
    });
}
mapArrayUrls(thing.thumbnailUrls || []);
(thing.billOfMaterials || []).forEach(function(bom) {
    mapFieldUrls(bom, ['url', 'thumbnailUrl']);
});
(thing.instructions || []).forEach(function(instruct) {
    mapArrayUrls(instruct.images || []);
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
process.exit(0);
