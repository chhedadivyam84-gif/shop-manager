/* Bill scanning reads an API key from a sealed file and writes scans to
   disk. Neither exists here yet, so it reports itself as unconfigured —
   which is a state the UI already knows how to display. */
module.exports = {
  configured: () => false,
  apiKey: () => null,
  keyFromEnv: () => null,
  saveKey: () => { throw new Error("Bill scanning is not configured on this deployment."); },
  clearKey: () => {},
  readBill: () => { throw new Error("Bill scanning is not available on this deployment."); },
  matchToCatalogue: () => [],
  matchSupplier: () => null,
  MODEL: null,
  MAX_BYTES: 0,
};
