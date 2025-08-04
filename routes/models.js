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

function validateUrl(string) {
    try {
        const url = new URL(string);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

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
            // Validate URL first
            if (!validateUrl(fileUrl)) {
                res.status(400).json({ error: 'Invalid URL provided. Please provide a valid HTTP/HTTPS URL.' });
                return;
            }
            
            // Cloud file URL provided
            isDownloadedFile = true;
            fileName = path.basename(new URL(fileUrl).pathname) || `model_${Date.now()}.dwg`;
            filePath = path.join(__dirname, '../temp', fileName);
            
            // Ensure temp directory exists
            const tempDir = path.dirname(filePath);
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }
            
            // Download file from cloud URL with enhanced configuration
            console.log('Attempting to download file from:', fileUrl);
            
            // Create axios instance with custom configuration
            const axiosInstance = axios.create({
                timeout: 600000, // Increase to 10 minutes
                maxRedirects: 10,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });
            
            const response = await axiosInstance({
                method: 'GET',
                url: fileUrl,
                responseType: 'stream',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Cache-Control': 'no-cache'
                },
                validateStatus: function (status) {
                    return status >= 200 && status < 300;
                },
                // Add retry configuration
                retry: 3,
                retryDelay: (retryCount) => {
                    return retryCount * 2000; // 2s, 4s, 6s delays
                }
            });
            
            console.log('Download response status:', response.status);
            console.log('Content-Type:', response.headers['content-type']);
            console.log('Content-Length:', response.headers['content-length']);
            
            // Create write stream with error handling
            const writeStream = fs.createWriteStream(filePath);
            
            // Add progress tracking for large files
            let downloadedBytes = 0;
            const totalBytes = parseInt(response.headers['content-length']) || 0;
            
            response.data.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (totalBytes > 0) {
                    const progress = ((downloadedBytes / totalBytes) * 100).toFixed(2);
                    console.log(`Download progress: ${progress}% (${downloadedBytes}/${totalBytes} bytes)`);
                }
            });
            
            // Use pipeline with better error handling
            await new Promise((resolve, reject) => {
                const stream = pipeline(response.data, writeStream, (error) => {
                    if (error) {
                        console.error('Pipeline error:', error);
                        reject(error);
                    } else {
                        console.log('File downloaded successfully');
                        resolve();
                    }
                });
                
                // Add timeout for the entire download process
                const downloadTimeout = setTimeout(() => {
                    writeStream.destroy();
                    reject(new Error('Download timeout exceeded'));
                }, 900000); // 15 minutes total timeout
                
                stream.on('finish', () => {
                    clearTimeout(downloadTimeout);
                });
                
                stream.on('error', (error) => {
                    clearTimeout(downloadTimeout);
                    reject(error);
                });
            });
            
        } else {
            res.status(400).send('Either "modelFile" upload or "fileUrl" is required.');
            return;
        }

        // Verify file was downloaded/uploaded successfully
        if (!fs.existsSync(filePath)) {
            throw new Error('File was not successfully downloaded or uploaded');
        }
        
        const fileStats = fs.statSync(filePath);
        console.log(`File size: ${fileStats.size} bytes`);
        
        if (fileStats.size === 0) {
            throw new Error('Downloaded file is empty');
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
        console.error('Full error object:', err);
        console.error('Error message:', err.message);
        console.error('Error code:', err.code);
        console.error('Error name:', err.name);
        console.error('Error stack:', err.stack);
        
        if (err.response) {
            console.error('Response status:', err.response.status);
            console.error('Response statusText:', err.response.statusText);
            console.error('Response headers:', err.response.headers);
        }
        
        if (err.config) {
            console.error('Request URL:', err.config.url);
            console.error('Request method:', err.config.method);
        }
        
        // Clean up temporary file in case of error
        if (isDownloadedFile && filePath && fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (cleanupErr) {
                console.error('Error cleaning up temp file:', cleanupErr);
            }
        }
        
        // Send appropriate error response
        let errorMessage = 'Unknown error occurred';
        
        if (err.code === 'ENOTFOUND') {
            errorMessage = 'Domain not found. Please check if the URL is valid.';
        } else if (err.code === 'ECONNREFUSED') {
            errorMessage = 'Connection refused. The server is not accepting connections.';
        } else if (err.code === 'ETIMEDOUT') {
            errorMessage = 'Request timed out. The file might be too large or server is slow. Please try again or use a smaller file.';
        } else if (err.code === 'ECONNRESET') {
            errorMessage = 'Connection was reset by the server. Please try again.';
        } else if (err.response?.status === 404) {
            errorMessage = 'File not found at the provided URL (404).';
        } else if (err.response?.status === 403) {
            errorMessage = 'Access denied. The file may require authentication (403).';
        } else if (err.response?.status === 500) {
            errorMessage = 'Server error at the provided URL (500).';
        } else if (err.message?.includes('timeout')) {
            errorMessage = 'Download timeout exceeded. The file is too large or connection is too slow.';
        } else if (err.message) {
            errorMessage = err.message;
        } else if (err.name) {
            errorMessage = `${err.name}: ${err.code || 'Unknown error code'}`;
        }
        
        res.status(500).json({ 
            error: errorMessage,
            details: {
                code: err.code,
                name: err.name,
                status: err.response?.status,
                url: err.config?.url,
                timeout: err.code === 'ETIMEDOUT' ? true : false
            }
        });
    }
});
router.post('/api/test-download', async function (req, res) {
    const { fileUrl } = req.body;
    
    if (!fileUrl) {
        return res.status(400).json({ error: 'fileUrl is required' });
    }
    
    try {
        console.log('Testing download from:', fileUrl);
        
        const response = await axios({
            method: 'HEAD', // Just get headers first
            url: fileUrl,
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        res.json({
            success: true,
            status: response.status,
            headers: response.headers,
            contentType: response.headers['content-type'],
            contentLength: response.headers['content-length']
        });
        
    } catch (err) {
        console.error('Test download error:', err);
        res.json({
            success: false,
            error: err.message,
            code: err.code,
            status: err.response?.status,
            details: err.response?.data
        });
    }
});

module.exports = router;
