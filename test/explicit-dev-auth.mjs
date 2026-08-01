// Test suites that use development identity headers must opt in explicitly.
// Production code never imports this module.
if (process.env.NODE_ENV === 'production') {
  throw new Error('explicit development auth cannot run with NODE_ENV=production');
}
if (process.env.CONVERACT_AUTH_DISABLED === undefined && process.env.OPC_AUTH_DISABLED === undefined) {
  process.env.CONVERACT_AUTH_DISABLED = '1';
}
