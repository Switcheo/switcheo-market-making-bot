const { Bot } = require('../src/Bot')
const API = require('../src/API')
const Wallet = require('../src/Wallet')

// Test initialize
test('Tests bot initializes', async () => {
  config = { network: 'TestNet' }
  api = new API(config.network)
  const assetsStub = {
    ETH:
      {
        symbol: 'ETH',
        name: 'Ethereum',
        type: 'ETH',
        hash: '0x0000000000000000000000000000000000000000',
        decimals: 18,
        transferDecimals: 18,
        precision: 4,
        minimumQuantity: '100000000000000000',
        tradingActive: true,
        isStablecoin: false,
        stablecoinType: null,
        active: true
      },
  }

  const pairsStub = {
    JRC_ETH:
      {
        name: 'JRC_ETH',
        precision: 5,
        baseAssetName: 'JRC',
        baseAssetSymbol: 'JRC',
        baseContract: '0x2af5d2ad76741191d15dfe7bf6ac92d4bd912ca3',
        quoteAssetName: 'Ethereum',
        quoteAssetSymbol: 'ETH',
        quoteContract: '0x0000000000000000000000000000000000000000'
      },
  }

  api.assets = assetsStub
  api.pairs = pairsStub

  wallet = { id: 1, blockchain: 'eth', envVarForKey: 'ETH_KEY_1' }
  wallet = new Wallet({ ...wallet, api, network: config.network })
  wallet.initialize()

  b = Bot.initialize({
    id: 11,
    strategy: {
      name: 'uniswap_mm_v2',
      config: { pair: 'JRC_ETH' },
      settings: {
        pair: 'JRC_ETH',
        minTick: '1 x',
        searchTick: '1 x',
        initialTickProfit: 10,
        subsequentTickProfit: 20,
        margin: 1,
        maxQuotes: 5,
        requoteRatio: 0.1,
      }
    },
    inventory: { JRC: 1, ETH: 1 },
    wallet: wallet,
    api,
  })
})
