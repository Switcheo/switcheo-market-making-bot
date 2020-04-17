function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getBlockchainForType(type) {
  switch (type) {
    case 'NEO':
    case 'NEP-5':
      return 'neo'
    case 'ETH':
    case 'ERC-20':
      return 'eth'
    case 'EOS':
      return 'eos'
    default:
      throw new Error('Unknown asset type!')
  }
}

function getEthereumProviderForNetwork(network) {
  return network === 'MainNet' ?
    'https://mainnet.infura.io/v3/51acfbe6359d4f83afa6f4fc345f7206' :
    'https://ropsten.infura.io/v3/51acfbe6359d4f83afa6f4fc345f7206'
}

module.exports = {
  sleep,
  getBlockchainForType,
  getEthereumProviderForNetwork,
}
