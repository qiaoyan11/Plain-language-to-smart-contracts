// Local, disposable accounts only. No public network or private key configuration.
module.exports = {
  solidity: "0.8.28",
  // Mine failed transactions so tests can inspect actual status=0 receipts.
  networks: { hardhat: { chainId: 31337, throwOnTransactionFailures: false } }
};
