/* Seals secrets against a key file on disk. On Workers, secrets are
   Cloudflare secrets and there is no key file, so nothing is sealed. */
module.exports = {
  seal: (v) => v,
  open: (v) => v,
  isSealed: () => false,
  keyPath: () => null,
};
