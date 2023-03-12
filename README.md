# Bitcoin relay off-chain app

A nodejs app, utilizing bitcoin full node and synchronizing all blockheaders to [program on Solana](https://github.com/adambor/BTCRelay-Sol)

## Requirements
* bitcoind node (Download latest from [here](https://bitcoincore.org/en/download/) or [build from source](https://baloian.medium.com/how-to-setup-and-run-a-bitcoin-full-node-on-ubuntu-a106fb86dbb3))
* nodejs
* npm

## Installation
1. Install npm packages: ```npm install```
2. Setup bitcoind node in testnet mode (example config is in [bitcoin.conf](https://github.com/adambor/BTCRelay-Sol-Offchain/bitcoin.conf) file)
3. Rename _.env file to .env
4. Fill in the details of your bitcoind node in .env file (you don't have to edit this file when using local node and a provided [bitcoin.conf](https://github.com/adambor/BTCRelay-Sol-Offchain/bitcoin.conf) config)
5. Generate a new solana keypair: ```npm run genKey```
6. Airdrop some devnet tokens to your newly generated solana wallet: ```npm run airdrop```
7. Run the app with: ```npm start```