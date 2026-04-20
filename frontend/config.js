// Auto-detect environment
const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const isFileProtocol = window.location.protocol === 'file:';

// Optional override from URL (for Cloudflare tunnel share link)
// e.g. ?anim=https://anim-xxx.trycloudflare.com
const params = new URLSearchParams(window.location.search);
const animOverride = params.get('anim');

function getApiBaseUrl() {
  if (animOverride) {
    // When using tunnel, we're on a public host; API might be same origin or tunnel
    const apiParam = params.get('api');
    if (apiParam) return apiParam.replace(/\/$/, '');
    return ''; // same origin for chat API if both behind one proxy
  }
  if (isFileProtocol) return 'http://localhost:3002';
  if (isLocalhost) return 'http://localhost:3002';
  return '';
}

function getAnimationServerUrl() {
  if (animOverride) return animOverride.replace(/\/$/, '');
  if (isFileProtocol) return 'http://localhost:3003';
  if (isLocalhost) return 'http://localhost:3003';
  const port = window.location.port;
  if (port && port !== '80' && port !== '443') {
    // Accessed directly on a non-standard port (e.g. :3002); animation is behind nginx on port 80
    return `${window.location.protocol}//${window.location.hostname}`;
  }
  return '';
}

const CONFIG = {
  API_BASE_URL: getApiBaseUrl(),
  ANIMATION_SERVER_URL: getAnimationServerUrl()
};

console.log('Config:', CONFIG);
