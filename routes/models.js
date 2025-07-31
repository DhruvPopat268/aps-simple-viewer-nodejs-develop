const express = require('express');
const formidable = require('express-formidable');
const { listObjects, uploadObject, translateObject, getManifest, urnify } = require('../services/aps.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const pipeline = promisify(require('stream').pipeline);

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

// router.post('/api/models', formidable({ maxFileSize: Infinity }), async function (req, res, next) {
//     const file = req.files['modelFile'];
//     if (!file) {
//         res.status(400).send('The required field ("modelFile") is missing.');
//         return;
//     }

//     try {
//         const obj = await uploadObject(file.name, file.path);
//         const urn = urnify(obj.objectId);
//         await translateObject(urn, req.fields['model-zip-entrypoint']);

//         // Send back full URL with hash to client
//         res.json({
//             name: obj.objectKey,
//             urn,
//             viewerUrl: `https://autocad-file-backend.onrender.com#${urn}`
//         });
//     } catch (err) {
//         next(err);
//     }
// });

router.post('/api/models', formidable({ maxFileSize: Infinity }), async function (req, res, next) {
    let filePath = null;
    let fileName = null;
    let isDownloadedFile = false;

    try {
        // Check if it's a traditional file upload
        const uploadedFile = req.files['modelFile'];
        const fileUrl = req.fields['fileUrl'] || req.body.fileUrl;

        if (uploadedFile) {
            // Traditional file upload
            filePath = uploadedFile.path;
            fileName = uploadedFile.name;
        } else if (fileUrl) {
            // Cloud file URL provided
            isDownloadedFile = true;
            fileName = path.basename(new URL(fileUrl).pathname) || `model_${Date.now()}.dwg`;
            filePath = path.join(__dirname, '../temp', fileName);

            // Ensure temp directory exists
            const tempDir = path.dirname(filePath);
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            // Download file from cloud URL
            const response = await axios({
                method: 'GET',
                url: fileUrl,
                responseType: 'stream',
                timeout: 30000, // 30 second timeout
            });

            // Save the downloaded file
            await pipeline(response.data, fs.createWriteStream(filePath));
        } else {
            res.status(400).send('Either "modelFile" upload or "fileUrl" is required.');
            return;
        }

        // Continue with existing logic
        const obj = await uploadObject(fileName, filePath);
        const urn = urnify(obj.objectId);
        await translateObject(urn, req.fields['model-zip-entrypoint']);

        // Clean up temporary file if it was downloaded
        if (isDownloadedFile && filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        // Send back full URL with hash to client
        res.json({
            name: obj.objectKey,
            urn,
            viewerUrl: `https://autocad-file-backend.onrender.com#${urn}`
        });
    } catch (err) {
        // Clean up temporary file in case of error
        if (isDownloadedFile && filePath && fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (cleanupErr) {
                console.error('Error cleaning up temp file:', cleanupErr);
            }
        }
        next(err);
    }
});

module.exports = router;