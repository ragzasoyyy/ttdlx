# TikTok API Wrapper (Vercel-ready)

Deploy: push to a Git repo and deploy to Vercel.

## Setup
1. Put `TT_COOKIE` and/or `PROXY` (optional) in Vercel Environment Variables (Project Settings -> Environment Variables).
   - TT_COOKIE: TikTok cookie string if required.
   - PROXY: HTTP proxy url if needed.

2. Deploy to Vercel (connect repo and Deploy).

3. After deploy:
   - Open root URL (serves public/index.html) to test.
   - API endpoints are under: https://<your-deploy>/api/tiktok?op=download&url=...
   - Use `&dl=1` when you want to stream/download the video file directly through the API.

## Notes
- This is an unofficial wrapper that uses @tobyg74/tiktok-api-dl.
- Vercel serverless functions have execution time limits — large video fetch might be limited by platform restrictions. If you need heavy streaming at scale, consider deploying to a full Node VM or specialized media-optimized hosting.
- Use TTL caching (5 minutes) to reduce load and improve speed for repeated requests.
