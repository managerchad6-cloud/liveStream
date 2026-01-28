// Auto-detect environment
const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const isFileProtocol = window.location.protocol === 'file:';

const CONFIG = {
  // If served via nginx proxy, use empty string (same origin)
  // If running locally or via file://, use explicit URLs
  API_BASE_URL: isFileProtocol
    ? 'http://localhost:3002'
    : (isLocalhost ? 'http://localhost:3002' : ''),

  ANIMATION_SERVER_URL: isFileProtocol
    ? 'http://localhost:3003'
    : (isLocalhost ? 'http://localhost:3003' : 'http://93.127.214.75:3003')
};

console.log('Config:', CONFIG);
