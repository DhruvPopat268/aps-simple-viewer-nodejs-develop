const express = require('express');
const formidable = require('express-formidable');
const { listObjects, uploadObject, translateObject, getManifest, urnify } = require('../services/aps.js');

let router = express.Router();

router.get('/api/models', async function (req, res, next) {
    try {
        const objects = await listObjects();
        res.json(objects.map(o => ({
            name: o.objectKey,
            urn: urnify(o.objectId)
        })));
    } catch (err) {
        next(err);
    }
});

router.get('/api/models/:urn/status', async function (req, res, next) {
    try {
        const manifest = await getManifest(req.params.urn);
        if (manifest) {
            let messages = [];
            if (manifest.derivatives) {
                for (const derivative of manifest.derivatives) {
                    messages = messages.concat(derivative.messages || []);
                    if (derivative.children) {
                        for (const child of derivative.children) {
                            messages.concat(child.messages || []);
                        }
                    }
                }
            }
            res.json({ status: manifest.status, progress: manifest.progress, messages });
        } else {
            res.json({ status: 'n/a' });
        }
    } catch (err) {
        next(err);
    }
});

router.post('/api/models', formidable({ maxFileSize: Infinity }), async function (req, res, next) {
    const file = req.files['modelFile'];
    if (!file) {
        res.status(400).send('The required field ("modelFile") is missing.');
        return;
    }

    try {
        const obj = await uploadObject(file.name, file.path);
        const urn = urnify(obj.objectId);
        await translateObject(urn, req.fields['model-zip-entrypoint']);

        // Send back full URL with hash to client
        res.json({
            name: obj.objectKey,
            urn,
            viewerUrl: `https://autocad-file-backend.onrender.com#${urn}`
        });
    } catch (err) {
        next(err);
    }
});


module.exports = router;
