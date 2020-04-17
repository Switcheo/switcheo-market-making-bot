const Web3 = require('web3')
const HDWalletProvider = require('truffle-hdwallet-provider')
const { getEthereumProviderForNetwork } = require('./utils')
const { logger, errorLogger } = require('./logger')

const {
  Account,
  EthPrivateKeyProvider,
  NeoPrivateKeyProvider,
  EosPrivateKeyProvider
} = require('switcheo-js')

class Wallet {
  constructor({ id, api, blockchain, network, envVarForKey }) {
    this.id = id
    this.api = api
    this.network = network
    this.blockchain = blockchain
    this.key = process.env[envVarForKey]
    this.balances = {
      human: {
        available: {},
        total: {},
        locked: {},
      },
      raw: {
        confirming: {},
        confirmed: {},
        locked: {},
      }
    }
  }

  async initialize() {
    logger().info('')
    if (this.initialized) throw new Error('Wallet already initialized!')

    const { blockchain, key } = this
    switch (blockchain) {
      case 'neo': {
        const provider = new NeoPrivateKeyProvider(key)
        this.account = new Account({ blockchain, provider })
        break
      }
      case 'eth': {
        if (!key || key === '') return null
        const node = getEthereumProviderForNetwork(this.network)
        const web3 = new Web3(new HDWalletProvider(key, node))
        const provider = await EthPrivateKeyProvider.init(web3, key)
        this.account = new Account({ blockchain, provider })
        break
      }
      case 'eos': {
        const provider = await EosPrivateKeyProvider.init(this.network, key)
        this.account = new Account({ blockchain, provider })
        break
      }
      default: {
        throw new Error(`Wallet not implemented for: ${blockchain}!`)
      }
    }

    await this.updateBalance()
    this.initialized = true
    logger().info(`Wallet ${this.id} initialized with address: ${this.account.displayAddress}`)

    return this
  }

  async updateBalance() {
    this.balances = await this.api.getBalance(this.account)
  }
}

module.exports = Wallet
