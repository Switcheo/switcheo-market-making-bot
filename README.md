# Switcheo Market Making Bot (Beta)

Automatated Market Making Bot to be used with Switcheo Exchange.

## Setup

### 1) Clone this repo

  ```bash
  git clone https://github.com/ConjurTech/switcheo-moonbot.git
  ```

### 2) Install redis

Follow instructions on:
```
https://redis.io/topics/quickstart
```

Mac OS:

```
brew update
brew install redis
brew services start redis
```

Test if redis is running:

`redis-cli ping`

### 3) Install dependencies

```bash
yarn
```

or

```bash
npm install
```

### 4) Setup config

Add your wallet

```yaml
wallets:
  - id: 0
    blockchain: 'neo'
    envVarForKey: 'NEO_KEY_0'
  - id: 1
```

And adjust any other settings.

### 5) Fund Wallet

Send funds to your wallet and deposit funds into the exchange
    
## Running the bot

`./src/index.js <command> [options]`

Example:

Production:

```bash
ETH_KEY_1=<your_private_key> node ./src/index.js run -e prod -r true -c config.local.yml
```

Local:

```bash
ETH_KEY_1=<your_private_key> node ./src/index.js run -e local -c config.local.yml
```

### List of parameters

Option        | Description                                                                | type
------------- | -------------------------------------------------------------------------- | ---------
-b, --bot     |  Bot IDs to run *[default: Runs all configured bots]*                      | [array]
-c, --config  |  Path to bot configuration file [default: config.<env>.yml]                | str
-e, --env     |  Environment to run in [choices: "dev", "test", "prod", "local"] [default: "dev"]   | str
-r, --report  |  Report errors to Sentry. requires SENTRY_DSN to be set [default: false]   | [boolean]
-h, --help    |  Show help                                                                 | [boolean]
-v, --version |  Show version number                                                       | [boolean]


## Interacting with the bot while running

| Command    | Description                                            |
|------------|--------------------------------------------------------|
| status     | Shows current status of moonbot                        |
| help       | Brings up the list of available commands               |
| start bot  | Brings up a list of bots to start                      |
| stop bot   | Brings up a list of bots to stop                       |
| create bot | Start the create bot process                           |
| delete bot | Deletes a saved bot permanently                        |
| config bot | Brings up a list of bots to start config process (Currently only support config of strategy) |

## Tracing bot while running

Run this on a separate terminal

```bash
tail -f logs/combined.log
```

## Changing Inventory of bot

Currently there is no support for changing inventory of bot, the easiest way now is to delete and recreate a new bot

## Strategies

### Algorithimic Market Making (uniswap_mm_v2)

#### Details

- Requires a last price on the market
- Uses a constant product formula x * y = k
- Automatically form discrete orders based on formula unlike normal uniswap

Example Pricing Calculation
```

SWTH_To_Give = SWTH_Balance - (SWTH_Balance * ETH_Balance) / (ETH_Balance + ETH_Received)

For example, if the algorithmic market maker has 100 ETH and 3.6 million SWTH, and if a user wants to buy SWTH using 1 ETH:

SWTH_To_Give = 3.6 million - 360 million / (100 + 1) = 35643.56436 SWTH

As the algorithmic market maker allocates more SWTH to users, the formula will result in less SWTH being given for a similar amount of ETH, resulting in the price of SWTH rising against ETH. On the other hand, if the algorithmic market maker gives more ETH to users, then the price of ETH will increase against SWTH. This provides fair pricing for users by allowing the price to be determined by the relative market demand of each asset.

```

#### Configuration

| Config               | Description                                                                                                  | example |
|----------------------|--------------------------------------------------------------------------------------------------------------|---------|
| pair                 | pair to use bot on                                                                                           | JRC_ETH |
| minTick              | the min diff in price level between each quote; can be an absolute size, or a multiplier of pair's minTick   | 1 x     |
| searchTick           | step size to search for the quotable price level; can be an absolute size, or a multiplier of pair's minTick | 1 x     |
| initialTickProfit    | in bips; increment initial tick quote price by this amount                                                   | 10      |
| subsequentTickProfit | in bips; increment subsequent tick quote price by this amount                                                | 20      |
| margin               | increase the uniswap inventory by this factor                                                                | 1       |
| maxQuotes            | max number of quotes on each side to place at once                                                           | 5       |
| requoteRatio         | requote if current qty exceeds more than this factor of required quantity                                    | 0.1     |
