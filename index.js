require('dotenv').config();
const RpcClient = require('bitcoind-rpc');
const anchor = require("@project-serum/anchor");
const web3 = require("@solana/web3.js");
const programIdl = require("./programIdl");
const crypto = require("crypto");

const blockUtils = require("./blockUtils");

const forkedBlocks = require("./forkedBlocks");

const STATE_SEED = "state";
const HEADER_SEED = "header";
const FORK_SEED = "fork";

const privKey = process.env.SOL_PRIVKEY;

const _signer = web3.Keypair.fromSecretKey(Buffer.from(privKey, "hex"));

const connection = new web3.Connection(process.env.SOL_RPC_URL, "processed");
const _client = new anchor.AnchorProvider(connection, new anchor.Wallet(_signer), {
    preflightCommitment: "processed"
});

const coder = new anchor.BorshCoder(programIdl);
const program = new anchor.Program(programIdl, programIdl.metadata.address, _client);
const eventParser = new anchor.EventParser(program.programId, coder);

const config = {
    protocol: process.env.BTC_PROTOCOL,
    user: process.env.BTC_RPC_USERNAME,
    pass: process.env.BTC_RPC_PASSWORD,
    host: process.env.BTC_HOST,
    port: process.env.BTC_PORT,
};

console.log("bitcoind connecting...");
const rpc = new RpcClient(config);
console.log("bitcoind connected");

const MAX_HEADERS_PER_TX = 7;
const MAX_HEADERS_PER_TX_FORK = 6;

const mainStateKey = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(STATE_SEED)],
    program.programId
)[0];

function getHeaderTopic(serializedHeader) {
    return web3.PublicKey.findProgramAddressSync(
        [Buffer.from(HEADER_SEED), serializedHeader.hash],
        program.programId
    )[0];
}

function getForkStateKey(forkId) {
    const buff = Buffer.alloc(8);
    buff.writeBigUint64LE(BigInt(forkId));
    return web3.PublicKey.findProgramAddressSync(
        [Buffer.from(FORK_SEED), buff, _signer.publicKey.toBuffer()],
        program.programId
    )[0];
}


async function getForkBlock(forkedBlock) {
    let blockHeader = forkedBlock;
    while(blockHeader.confirmations===-1) {
        blockHeader = await new Promise((resolve, reject) => {
            rpc.getBlockHeader(blockHeader.previousblockhash, true, (err, info) => {
                if(err) {
                    reject(err);
                    return;
                }
                resolve(info.result);
            });
        });
    }
    return blockHeader;
}

function serializeBlockHeader(e) {
    return {
        version: e.version,
        reversedPrevBlockhash: [...Buffer.from(e.previousblockhash, "hex").reverse()],
        merkleRoot: [...Buffer.from(e.merkleroot, "hex").reverse()],
        timestamp: e.time,
        nbits: Buffer.from(e.bits, "hex").readUint32BE(),
        nonce: e.nonce,
        hash: Buffer.from(e.hash, "hex").reverse()
    };
}


async function saveMainHeaders(mainHeaders, storedHeader) {
    const blockHeaderObj = mainHeaders.map(serializeBlockHeader);

    console.log("[BTCRelay: Solana.submitMainChainHeaders] Submitting headers: ", blockHeaderObj);

    const tx = await program.methods
        .submitBlockHeaders(
            blockHeaderObj,
            storedHeader
        )
        .accounts({
            signer: _signer.publicKey,
            mainState: mainStateKey,
            //systemProgram: web3.SystemProgram.programId,
        })
        .remainingAccounts(blockHeaderObj.map(e => {
            return {
                pubkey: getHeaderTopic(e),
                isSigner: false,
                isWritable: false
            }
        }))
        .signers([_signer])
        .transaction();

    const signature = await _client.sendAndConfirm(tx, [_signer]);

    console.log("[BTCRelay: Solana.submitMainChainHeaders] Transactions sent: ", signature);

    let fetchedTx = null;
    while(fetchedTx==null) {
        fetchedTx = await _client.connection.getTransaction(signature, {
            commitment: "confirmed"
        });
    }

    console.log("[BTCRelay: Solana.submitMainChainHeaders] Transaction confirmed! Receipt: ", fetchedTx);

    if(fetchedTx.meta.err) {
        throw new Error("Transaction execution failed: "+fetchedTx.meta.err);
    }

    const events = eventParser.parseLogs(fetchedTx.meta.logMessages);

    let lastStoredHeader;
    for(let log of events) {
        if(log.name==="StoreFork") {
            lastStoredHeader = log.data.header;
        }
        if(log.name==="StoreHeader") {
            lastStoredHeader = log.data.header;
        }
        //console.log(JSON.stringify(log.data.header, null, 4));
    }

    return {
        forkId: 0,
        lastStoredHeader,
        numHeaders: mainHeaders.length
    }
}

async function saveMainHeadersFastSync(mainHeaders, storedHeader) {
    const blockHeaderObj = mainHeaders.map(serializeBlockHeader);

    //console.log("[BTCRelay: Solana.submitMainChainHeaders] Submitting headers: ", blockHeaderObj);

    const height = await _client.connection.getSlot("confirmed");

    const numTxns = Math.floor(blockHeaderObj.length / 7)+1;

    console.log("Confirmed height: ", height);

    let storedHeaderBuffer = [];
    let i = 0;

    let computedStoredHeader = storedHeader;

    const signatures = [];

    const sendTx = async () => {

        const ix = await program.methods
            .submitBlockHeaders(
                storedHeaderBuffer,
                computedStoredHeader
            )
            .accounts({
                signer: _signer.publicKey,
                mainState: mainStateKey,
                //systemProgram: web3.SystemProgram.programId,
            })
            .remainingAccounts(storedHeaderBuffer.map(e => {
                return {
                    pubkey: getHeaderTopic(e),
                    isSigner: false,
                    isWritable: false
                }
            }))
            .signers([_signer])
            .instruction();

        const tx = new web3.Transaction()
            .add(web3.ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: (numTxns-i)*50
            }))
            .add(ix);
        const {blockhash} = await _client.connection.getBlock(height-(i), {
            commitment: "confirmed"
        });
        tx.recentBlockhash = blockhash;
        tx.feePayer = _signer.publicKey;
        const signedTx = await new anchor.Wallet(_signer).signTransaction(tx);
        const signature = await _client.connection.sendRawTransaction(signedTx.serialize(), {
            skipPreflight: true
        });
        //await new Promise((resolve) => setTimeout(resolve, 100));
        i++;
        computedStoredHeader = blockUtils.computeCommitedHeader(computedStoredHeader, storedHeaderBuffer);
        storedHeaderBuffer = [];
        signatures.push(signature);
        console.log("Signature "+i+": ", signature);
    };

    for(let blockHeader of blockHeaderObj) {
        storedHeaderBuffer.push(blockHeader);
        if(storedHeaderBuffer.length>=7) {
            await sendTx();
        }
    }

    if(storedHeaderBuffer.length>0) {
        await sendTx();
    }

    console.log("[BTCRelay: Solana.submitMainChainHeaders] Transactions sent: ", signatures);

    let fetchedTx = null;
    while(fetchedTx==null) {
        fetchedTx = await _client.connection.getTransaction(signatures[signatures.length-1], {
            commitment: "confirmed"
        });
        if(fetchedTx!=null && signatures.length>1 && fetchedTx.meta.err) {
            signatures.pop();
            fetchedTx = null;
        }
    }

    console.log("Successful transactions: ", signatures.length);

    if(fetchedTx.meta.err) {
        throw new Error("Transaction execution failed: "+fetchedTx.meta.err);
    }

    const events = eventParser.parseLogs(fetchedTx.meta.logMessages);

    let lastStoredHeader;
    for(let log of events) {
        if(log.name==="StoreFork") {
            lastStoredHeader = log.data.header;
        }
        if(log.name==="StoreHeader") {
            lastStoredHeader = log.data.header;
        }
    }

    return {
        forkId: 0,
        lastStoredHeader,
        numHeaders: lastStoredHeader.blockheight-storedHeader.blockheight
    }
}

//Returns forkID or 0 if ChainReorg event was emitted
//TODO: Fix to retry if forkCounter is already used
async function saveNewForkHeaders(forkHeaders, storedHeader) {
    const blockHeaderObj = forkHeaders.map(serializeBlockHeader);

    const mainState = await program.account.mainState.fetch(mainStateKey);

    const forkId = mainState.forkCounter;

    console.log("[BTCRelay: Solana.submitNewForkChainHeaders] Submitting headers: ", blockHeaderObj);

    const tx = await program.methods
        .submitForkHeaders(
            blockHeaderObj,
            storedHeader,
            forkId,
            true
        )
        .accounts({
            signer: _signer.publicKey,
            mainState: mainStateKey,
            forkState: getForkStateKey(forkId),
            systemProgram: web3.SystemProgram.programId,
        })
        .remainingAccounts(blockHeaderObj.map(e => {
            return {
                pubkey: getHeaderTopic(e),
                isSigner: false,
                isWritable: false
            }
        }))
        .signers([_signer])
        .transaction();

    const signature = await _client.sendAndConfirm(tx, [_signer], {
        skipPreflight: true
    });

    console.log("[BTCRelay: Solana.submitNewForkChainHeaders] Transaction sent: ", signature);

    let fetchedTx = null;
    while(fetchedTx==null) {
        fetchedTx = await _client.connection.getTransaction(signature, {
            commitment: "confirmed"
        });
    }

    console.log("[BTCRelay: Solana.submitNewForkChainHeaders] Transaction confirmed! Receipt: ", fetchedTx);

    if(fetchedTx.meta.err) {
        throw new Error("Transaction execution failed: "+fetchedTx.meta.err);
    }

    const events = eventParser.parseLogs(fetchedTx.meta.logMessages);

    let lastStoredHeader;
    for(let log of events) {
        if(log.name==="StoreFork") {
            lastStoredHeader = log.data.header;
        }
        if(log.name==="StoreHeader") {
            lastStoredHeader = log.data.header;
        }
    }

    return {
        forkId,
        lastStoredHeader
    }
}

//TODO: Fix to retry if forkCounter is already used
async function saveForkHeaders(forkHeaders, storedHeader, forkId) {
    const blockHeaderObj = forkHeaders.map(serializeBlockHeader);

    console.log("[BTCRelay: Solana.submitForkChainHeaders] Submitting headers: ", blockHeaderObj);

    const tx = await program.methods
        .submitForkHeaders(
            blockHeaderObj,
            storedHeader,
            forkId,
            false
        )
        .accounts({
            signer: _signer.publicKey,
            mainState: mainStateKey,
            forkState: getForkStateKey(forkId),
            systemProgram: web3.SystemProgram.programId,
        })
        .remainingAccounts(blockHeaderObj.map(e => {
            return {
                pubkey: getHeaderTopic(e),
                isSigner: false,
                isWritable: false
            }
        }))
        .signers([_signer])
        .transaction();

    const signature = await _client.sendAndConfirm(tx, [_signer]);

    console.log("[BTCRelay: Solana.submitForkChainHeaders] Transaction sent: ", signature);

    let fetchedTx = null;
    while(fetchedTx==null) {
        fetchedTx = await _client.connection.getTransaction(signature, {
            commitment: "confirmed"
        });
    }

    console.log("[BTCRelay: Solana.submitForkChainHeaders] Transaction confirmed! Receipt: ", fetchedTx);

    if(fetchedTx.meta.err) {
        throw new Error("Transaction execution failed: "+fetchedTx.meta.err);
    }

    const events = eventParser.parseLogs(fetchedTx.meta.logMessages);

    let lastStoredHeader;
    for(let log of events) {
        if(log.name==="StoreFork") {
            lastStoredHeader = log.data.header;
        }
        if(log.name==="StoreHeader") {
            lastStoredHeader = log.data.header;
        }
        if(log.name==="ChainReorg") {
            forkId = 0;
        }
    }

    return {
        forkId,
        lastStoredHeader
    }
}

const limit = 500;

async function retrieveLog(spvCommitmentHash, blockHash) {
    //Retrieve the log

    const topic = getHeaderTopic({hash: blockHash});

    let storedHeader = null;
    let lastSignature = null;
    while(storedHeader==null) {
        let fetched;
        if(lastSignature==null) {
            fetched = await _client.connection.getSignaturesForAddress(topic, {
                limit
            }, "confirmed");
        } else {
            fetched = await _client.connection.getSignaturesForAddress(topic, {
                before: lastSignature,
                limit
            }, "confirmed");
        }
        if(fetched.length===0) throw new Error("Block cannot be fetched");
        lastSignature = fetched[fetched.length-1].signature;
        for(let data of fetched) {
            const tx = await _client.connection.getTransaction(data.signature, {
                commitment: "confirmed"
            });
            if(tx.meta.err) continue;

            const events = eventParser.parseLogs(tx.meta.logMessages);

            for(let log of events) {
                if(log.name==="StoreFork" || log.name==="StoreHeader") {
                    if(Buffer.from(log.data.commitHash).equals(spvCommitmentHash)) {
                        storedHeader = log.data.header;
                        break;
                    }
                }
            }

            if(storedHeader!=null) break;
        }

    }

    return storedHeader;
}

async function retrieveLatestKnownBlockLog() {
    //Retrieve the log
    let storedHeader = null;
    let bitcoinHeader = null;

    let lastSignature = null;

    const mainState = await program.account.mainState.fetch(mainStateKey);

    const storedCommitments = new Set();
    mainState.blockCommitments.forEach(e => {
        storedCommitments.add(Buffer.from(e).toString("hex"));
    });

    while(storedHeader==null) {
        let fetched;
        if(lastSignature==null) {
            fetched = await _client.connection.getSignaturesForAddress(program.programId, {
                limit
            }, "confirmed");
        } else {
            fetched = await _client.connection.getSignaturesForAddress(program.programId, {
                before: lastSignature,
                limit
            }, "confirmed");
        }
        if(fetched.length===0) throw new Error("Block cannot be fetched");
        lastSignature = fetched[fetched.length-1].signature;
        for(let data of fetched) {
            const tx = await _client.connection.getTransaction(data.signature, {
                commitment: "confirmed"
            });
            if(tx.meta.err) continue;

            const events = eventParser.parseLogs(tx.meta.logMessages);

            for(let log of events) {
                if(log.name==="StoreFork" || log.name==="StoreHeader") {
                    const blockHash = Buffer.from(log.data.blockHash);
                    try {
                        const btcBlockHeader = await new Promise((resolve, reject) => {
                            rpc.getBlockHeader(blockHash.reverse().toString("hex"), true, (err, info) => {
                                if(err) {
                                    reject(err);
                                    return;
                                }
                                resolve(info.result);
                            });
                        });
                        //Check if this fork is part of main chain
                        const commitHash = Buffer.from(log.data.commitHash).toString("hex");
                        if(storedCommitments.has(commitHash)) {
                            bitcoinHeader = btcBlockHeader;
                            storedHeader = log.data.header;
                            break;
                        }
                    } catch (e) {
                        //Still in a fork
                    }
                }
            }

            if(storedHeader!=null) break;
        }
    }

    return {
        resultStoredHeader: storedHeader,
        resultBitcoinHeader: bitcoinHeader
    };
}

function dblSha256(data) {
    const hash1 = crypto.createHash("sha256").update(data).digest();
    return crypto.createHash("sha256").update(hash1).digest();
}

// Default: 768686
async function initializeAccount(blockHash) {

    const header = await new Promise((resolve, reject) => {
        rpc.getBlockHeader(blockHash, true, (err, info) => {
            if(err) {
                reject(err);
                return;
            }
            resolve(info.result);
        });
    });

    console.log("Blockhash: ", blockHash.toString("hex"));

    const parsedHeader = serializeBlockHeader(header);

    const blockTopicKey = getHeaderTopic(parsedHeader);

    const lastDiffAdjustmentHeight = Math.floor(header.height/2016)*2016;

    const diffAdjBlockHash = await new Promise((resolve, reject) => {
        rpc.getBlockHash(lastDiffAdjustmentHeight, (err, info) => {
            if(err) {
                reject(err);
                return;
            }
            resolve(info.result);
        });
    });

    const diffAdjBlock = await new Promise((resolve, reject) => {
        rpc.getBlockHeader(diffAdjBlockHash, true, (err, info) => {
            if(err) {
                reject(err);
                return;
            }
            resolve(info.result);
        });
    });

    const prevBlockTimestamps = [];

    let lastBlockHash = header.previousblockhash;
    for(let i=0;i<10;i++) {
        const prevBlockData = await new Promise((resolve, reject) => {
            rpc.getBlockHeader(lastBlockHash, true, (err, info) => {
                if(err) {
                    reject(err);
                    return;
                }
                resolve(info.result);
            });
        });
        prevBlockTimestamps[9-i] = prevBlockData.time;
        lastBlockHash = prevBlockData.previousblockhash;
    }

    const tx = await program.methods
        .initialize(
            parsedHeader,
            header.height,
            [...Buffer.from(header.chainwork, "hex")],
            diffAdjBlock.time,
            prevBlockTimestamps
        )
        .accounts({
            signer: _signer.publicKey,
            headerTopic: blockTopicKey,
            mainState: mainStateKey,
            systemProgram: web3.SystemProgram.programId
        })
        .signers([_signer])
        .transaction();

    const result = await _client.sendAndConfirm(tx, [_signer], {
        skipPreflight: false
    });
}

async function airdrop() {

    const signature = await _client.connection.requestAirdrop(_signer.publicKey, 1000000000);
    const latestBlockhash = await _client.connection.getLatestBlockhash();
    await _client.connection.confirmTransaction(
        {
            signature,
            ...latestBlockhash,
        },
        "confirmed"
    );

}

async function main(submitFakeHeaders) {

    //await airdrop();

    const bitcoinInfo = await new Promise((resolve, reject) => {
        rpc.getBlockchainInfo((err, info) => {
            if(err) {
                reject(err);
                return;
            }
            resolve(info.result);
        });
    });

    console.log("Bitcoind info: ", bitcoinInfo);

    let acc;
    try {
        acc = await program.account.mainState.fetch(mainStateKey);
    } catch (e) {
        console.log("Initializing the account...");
        //We need to initialize
        await initializeAccount("000000001626af2806b9dda9b7bc2658ac01f79b5a3066301b65c7e65dad0671");
        console.log("Account initialized");
        await new Promise(resolve => {
            setTimeout(resolve, 3000);
        });
        acc = await program.account.mainState.fetch(mainStateKey);
    }

    acc.blockCommitments = null;

    console.log("Main state fetched: ", acc);

    const spvTipCommitment = Buffer.from(acc.tipCommitHash);
    const blockHashTip = Buffer.from(acc.tipBlockHash);

    let cacheData = {
        forkId: 0
    };
    let spvTipBlockHeader;
    try {
        const blockHashHex = Buffer.from(acc.tipBlockHash).reverse().toString("hex");
        console.log("Stored tip hash: ", blockHashHex);
        spvTipBlockHeader = await new Promise((resolve, reject) => {
            rpc.getBlockHeader(blockHashHex, true, (err, info) => {
                if(err) {
                    reject(err);
                    return;
                }
                resolve(info.result);
            });
        });
        cacheData.lastStoredHeader = await retrieveLog(spvTipCommitment, blockHashTip);
    } catch (e) {
        console.error(e);
        //Block not found, therefore relay tip is probably in a fork
        const {resultStoredHeader, resultBitcoinHeader} = await retrieveLatestKnownBlockLog();
        cacheData.lastStoredHeader = resultStoredHeader;
        cacheData.forkId = -1; //Indicate that we will be submitting blocks to fork
        spvTipBlockHeader = resultBitcoinHeader;
    }

    console.log("Retrieved stored header with commitment: ", cacheData.lastStoredHeader);

    console.log("SPV tip hash: ", blockHashTip.toString("hex"));

    console.log("SPV tip header: ", spvTipBlockHeader);

    if(submitFakeHeaders) {
        await saveMainHeaders(forkedBlocks, cacheData.lastStoredHeader);
        return;
    }

    if(spvTipBlockHeader.confirmations===-1) {
        //Block is not in main chain
        //Trace back to the height of the fork
        //First block that is part of this fork and is in the main chain
        spvTipBlockHeader = await getForkBlock(spvTipBlockHeader);

        cacheData.forkId = -1; //Indicate that we will be submitting blocks to fork
    }

    let headerCache = [];
    while(spvTipBlockHeader.nextblockhash!=null) {
        spvTipBlockHeader = await new Promise((resolve, reject) => {
            rpc.getBlockHeader(spvTipBlockHeader.nextblockhash, true, (err, info) => {
                if(err) {
                    reject(err);
                    return;
                }
                resolve(info.result);
            });
        });
        headerCache.push(spvTipBlockHeader);
        if(cacheData.forkId===0 ?
            headerCache.length>=MAX_HEADERS_PER_TX :
            headerCache.length>=MAX_HEADERS_PER_TX_FORK) {

            if(cacheData.forkId===-1) {
                cacheData = await saveNewForkHeaders(headerCache, cacheData.lastStoredHeader)
            } else if(cacheData.forkId===0) {
                cacheData = await saveMainHeaders(headerCache, cacheData.lastStoredHeader);
            } else {
                cacheData = await saveForkHeaders(headerCache, cacheData.lastStoredHeader, cacheData.forkId)
            }
            headerCache.splice(0, cacheData.numHeaders);
        }
        console.log("Blockheight: ", spvTipBlockHeader.height);
    }

    if(headerCache.length>0) {
        if(cacheData.forkId===-1) {
            cacheData = await saveNewForkHeaders(headerCache, cacheData.lastStoredHeader)
        } else if(cacheData.forkId===0) {
            cacheData = await saveMainHeaders(headerCache, cacheData.lastStoredHeader);
        } else {
            cacheData = await saveForkHeaders(headerCache, cacheData.lastStoredHeader, cacheData.forkId)
        }
    }

    console.log("Succesfully submitted all new blockheaders to BTCRelay")

}

async function start() {
    // let run;
    // run = async () => {
    //     await main().catch(e => console.error(e));
    //     console.log("Re-running in 60 seconds");
    //     setTimeout(run, 60*1000);
    // };
    // run();

    // const txs = [];
    //
    // const height = await _client.connection.getSlot("confirmed");
    //
    // console.log("Confirmed height: ", height);
    //
    // for(let i=0;i<5;i++) {
    //     const tx = new web3.Transaction()
    //         .add(web3.ComputeBudgetProgram.setComputeUnitPrice({
    //             microLamports: (6-i)*100
    //         }))
    //         .add(web3.SystemProgram.transfer({
    //             fromPubkey: _signer.publicKey,
    //             toPubkey: new web3.PublicKey("EeioDNWuuCfv8r4ppeHxrnugyoq2VB7xrNY92B8GgZ2d"),
    //             lamports: 100000
    //         }));
    //     const {blockhash} = await _client.connection.getBlock(height-i, {
    //         commitment: "confirmed"
    //     });
    //
    //     console.log("Blockhash: ", blockhash);
    //
    //     tx.recentBlockhash = blockhash;
    //     tx.feePayer = _signer.publicKey;
    //
    //     const signedTx = await new anchor.Wallet(_signer).signTransaction(tx);
    //
    //     const txResult = await _client.connection.sendRawTransaction(signedTx.serialize());
    //
    //     console.log("Signature "+i+": ", txResult);
    // }

    const blocks = [];

    let blockHash = "000000000000001a5927152995e6122b65a45571807c124d44be0674c9c24aeb"
    for(let i=0;i<50;i++) {
        const block = await new Promise((resolve, reject) => {
            rpc.getBlock(blockHash, 2, (err, info) => {
                if(err) {
                    reject(err);
                    return;
                }
                resolve(info.result);
            });
        });

        blockHash = block.nextblockhash;

        blocks.push(block);
    }

    const map = new Map();

    const startTime = Date.now();

    let totalTxs = 0;

    const blockTxoHashes = [];
    for(let block of blocks) {
        totalTxs += block.tx.length;
        for(let tx of block.tx) {
            for(let vout of tx.vout) {
                const voutHex = vout.scriptPubKey.hex;
                const buff = Buffer.alloc((voutHex.length/2) + 8);
                buff.writeBigUInt64LE(BigInt(Math.round(vout.value*100000000)));
                buff.write(voutHex, "hex");
                const txoHash = crypto.createHash("sha256").update(buff).digest();
                blockTxoHashes.push(txoHash);
                map.set(txoHash, {
                    txId: tx.txid,
                    vout: vout.n
                })
            }
        }
    }

    const timeTaken = Date.now()-startTime;

    console.log("Time taken: ", timeTaken);
    console.log("Total txs: ", totalTxs);

}

start().catch(e => {
    console.error(e);
});