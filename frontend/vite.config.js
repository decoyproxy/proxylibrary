export default {
  // Top-level await in main.js; every browser that runs WebGL2 handles it.
  build: { target: 'esnext' },
  server: {
    proxy: { '/api': 'http://localhost:8000' },
  },
};
