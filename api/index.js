// api/tiktok.js
// Vercel serverless function entry. Exposes endpoints under /api/*
// Endpoints supported:
// GET /api/tiktok?op=download&url=...&dl=1
// GET /api/tiktok?op=stalk&username=...
// GET /api/tiktok?op=getmusicvideos&musicId=...&p=1&c=20
// GET /api/tiktok?op=getuserposts&username=...
// GET /api/tiktok?op=getuserreposts&username=...
// GET /api/tiktok?op=getuserfavorites&username=...
// GET /api/tiktok?op=getvideocomments&url=...
// GET /api/tiktok?op=search&q=...
//
// Streaming download: add &dl=1 to download endpoint to stream proxied video to client.
//
// NOTE: Keep TT_COOKIE in Vercel Environment if some endpoints require it.

const Tiktok = require('@tobyg74/tiktok-api-dl');
const fetch = require('node-fetch');
const LRU = require('lru-cache');

const CACHE = new LRU({
  max: 500,
  ttl: 1000 * 60 * 5 // cache 5 minutes
});

function sendJson(res, code, obj) {
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = code;
  res.end(JSON.stringify(obj));
}

function buildOptions(query = {}) {
  const opt = {};
  if (process.env.PROXY) opt.proxy = process.env.PROXY;
  if (query.proxy) opt.proxy = query.proxy;
  if (process.env.TT_COOKIE) opt.COOKIE = process.env.TT_COOKIE;
  if (query.cookie) opt.COOKIE = query.cookie;
  if (query.version) opt.version = query.version;
  return opt;
}

// Helper to try multiple function names in package
async function callIfExists(names, ...args) {
  for (const n of names) {
    if (typeof Tiktok[n] === 'function') {
      return await Tiktok[n](...args);
    }
  }
  throw new Error('Function not available in installed package: ' + names.join(','));
}

module.exports = async (req, res) => {
  try {
    // We route everything to this file (vercel.json)
    const q = req.method === 'GET' ? req.query || (new URL(req.url, 'http://localhost')).searchParams : {};
    // In vercel serverless, req.query exists
    const op = (q.op || (q.get ? q.get : null) || '').toString().toLowerCase();

    // short helper to parse param
    const param = (name) => (q[name] !== undefined ? q[name] : null);

    // Basic health check
    if (!op || op === 'health' || op === 'ping') {
      return sendJson(res, 200, { status: 'success', message: 'tiktok-api-vercel OK' });
    }

    // Cache key
    const cacheKey = JSON.stringify({ op, ...q });

    // Download endpoint: streaming or metadata
    if (op === 'download') {
      const url = param('url');
      if (!url) return sendJson(res, 400, { status: 'error', message: 'Missing url query param' });

      // check cache for metadata
      if (CACHE.has(cacheKey) && !param('nocache')) {
        const cached = CACHE.get(cacheKey);
        // if streaming requested, but we have direct download url cached, stream it
        if (param('dl') === '1' && cached?.downloadAddr) {
          // Proxy stream
          const streamResp = await fetch(cached.downloadAddr);
          if (!streamResp.ok) {
            return sendJson(res, 502, { status: 'error', message: 'Failed to fetch video (cached) ' + streamResp.status });
          }
          res.setHeader('content-type', streamResp.headers.get('content-type') || 'video/mp4');
          res.setHeader('cache-control', 'public, max-age=31536000, immutable');
          streamResp.body.pipe(res);
          return;
        }
        return sendJson(res, 200, { status: 'success', cached: true, result: cached });
      }

      const options = buildOptions(q);
      // call Downloader from package (try a few names)
      let result;
      try {
        result = await callIfExists(['Downloader', 'Download', 'download', 'downloader'], url, options);
      } catch (e) {
        return sendJson(res, 500, { status: 'error', message: 'Downloader function missing or error', error: e.toString() });
      }

      // Normalize: try to find a direct download url (without watermark)
      // The package may return array or object. We attempt to pull the first download address.
      let downloadAddr = null;
      try {
        if (!result) {
          // nothing
        } else if (result.result && result.result.video && Array.isArray(result.result.video.downloadAddr)) {
          downloadAddr = result.result.video.downloadAddr[0];
        } else if (result.video && Array.isArray(result.video.downloadAddr)) {
          downloadAddr = result.video.downloadAddr[0];
        } else if (result.download && typeof result.download === 'string') {
          downloadAddr = result.download;
        } else if (Array.isArray(result.urls) && result.urls.length) {
          downloadAddr = result.urls[0];
        }
      } catch (e) {
        // ignore
      }

      // Save to cache minimal useful info
      const cachedObj = { meta: result, downloadAddr };
      CACHE.set(cacheKey, cachedObj);

      // If dl=1 then stream proxied content to client (fast)
      if (param('dl') === '1' && downloadAddr) {
        const streamResp = await fetch(downloadAddr);
        if (!streamResp.ok) {
          return sendJson(res, 502, { status: 'error', message: 'Failed to fetch video ' + streamResp.status });
        }
        // set headers for download
        res.setHeader('content-type', streamResp.headers.get('content-type') || 'video/mp4');
        res.setHeader('content-disposition', 'attachment; filename="tiktok_video.mp4"');
        // recommended caching for CDNs
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        streamResp.body.pipe(res);
        return;
      }

      // otherwise return metadata / result
      return sendJson(res, 200, { status: 'success', result: result, downloadAddr: downloadAddr });
    }

    // STALK (user profile)
    if (op === 'stalk') {
      const username = param('username');
      if (!username) return sendJson(res, 400, { status: 'error', message: 'Missing username' });
      const options = buildOptions(q);
      try {
        const result = await callIfExists(['Stalk', 'stalk', 'GetUserProfile', 'getUserProfile'], username, options);
        CACHE.set(cacheKey, result);
        return sendJson(res, 200, { status: 'success', result });
      } catch (e) {
        return sendJson(res, 500, { status: 'error', message: e.toString() });
      }
    }

    // getmusicvideos
    if (op === 'getmusicvideos') {
      const musicId = param('musicId');
      if (!musicId) return sendJson(res, 400, { status: 'error', message: 'Missing musicId' });
      const options = buildOptions(q);
      try {
        const result = await callIfExists(['GetMusicVideos', 'getMusicVideos', 'GetVideosByMusicId', 'getVideosByMusicId'], musicId, { page: param('p') ? Number(param('p')) : undefined, count: param('c') ? Number(param('c')) : undefined, ...options });
        CACHE.set(cacheKey, result);
        return sendJson(res, 200, { status: 'success', result });
      } catch (e) {
        return sendJson(res, 500, { status: 'error', message: e.toString() });
      }
    }

    // getuserposts
    if (op === 'getuserposts') {
      const username = param('username');
      if (!username) return sendJson(res, 400, { status: 'error', message: 'Missing username' });
      const options = buildOptions(q);
      try {
        const result = await callIfExists(['GetUserPosts', 'getUserPosts', 'GetPostsByUser', 'getPostsByUser'], username, { page: param('p') ? Number(param('p')) : undefined, count: param('c') ? Number(param('c')) : undefined, ...options });
        CACHE.set(cacheKey, result);
        return sendJson(res, 200, { status: 'success', result });
      } catch (e) {
        return sendJson(res, 500, { status: 'error', message: e.toString() });
      }
    }

    // getuserreposts
    if (op === 'getuserreposts') {
      const username = param('username');
      if (!username) return sendJson(res, 400, { status: 'error', message: 'Missing username' });
      const options = buildOptions(q);
      try {
        const result = await callIfExists(['GetUserReposts', 'getUserReposts'], username, { page: param('p') ? Number(param('p')) : undefined, count: param('c') ? Number(param('c')) : undefined, ...options });
        CACHE.set(cacheKey, result);
        return sendJson(res, 200, { status: 'success', result });
      } catch (e) {
        return sendJson(res, 500, { status: 'error', message: e.toString() });
      }
    }

    // getuserfavorites
    if (op === 'getuserfavorites' || op === 'getuserfavoritevideos') {
      const username = param('username');
      if (!username) return sendJson(res, 400, { status: 'error', message: 'Missing username' });
      const options = buildOptions(q);
      try {
        const result = await callIfExists(['GetUserFavoriteVideos', 'getUserFavoriteVideos', 'GetUserFavorites', 'getUserFavorites'], username, { page: param('p') ? Number(param('p')) : undefined, count: param('c') ? Number(param('c')) : undefined, ...options });
        CACHE.set(cacheKey, result);
        return sendJson(res, 200, { status: 'success', result });
      } catch (e) {
        return sendJson(res, 500, { status: 'error', message: e.toString() });
      }
    }

    // getvideocomments
    if (op === 'getvideocomments') {
      const url = param('url');
      if (!url) return sendJson(res, 400, { status: 'error', message: 'Missing url' });
      const options = buildOptions(q);
      try {
        const result = await callIfExists(['GetVideoComments', 'getVideoComments'], url, options);
        CACHE.set(cacheKey, result);
        return sendJson(res, 200, { status: 'success', result });
      } catch (e) {
        return sendJson(res, 500, { status: 'error', message: e.toString() });
      }
    }

    // search
    if (op === 'search') {
      const qstr = param('q');
      if (!qstr) return sendJson(res, 400, { status: 'error', message: 'Missing q' });
      const options = buildOptions(q);
      try {
        const result = await callIfExists(['Search', 'search', 'Find', 'find'], qstr, options);
        CACHE.set(cacheKey, result);
        return sendJson(res, 200, { status: 'success', result });
      } catch (e) {
        return sendJson(res, 500, { status: 'error', message: e.toString() });
      }
    }

    // not found
    return sendJson(res, 404, { status: 'error', message: 'Unknown op. Use ?op=download|stalk|getmusicvideos|getuserposts|getuserreposts|getuserfavorites|getvideocomments|search' });
  } catch (err) {
    console.error('Unhandled error', err);
    try {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'error', message: err?.message || 'Internal server error' }));
    } catch (e) {
      // nothing
    }
  }
};
