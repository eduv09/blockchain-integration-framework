import {
  IListenOptions,
  LogLevelDesc,
  LoggerProvider,
  Secp256k1Keys,
  Servers,
} from "@hyperledger/cactus-common";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import fs from "fs-extra";

import "jest-extended";
import LockAssetContractJson from "../solidity/lock-asset-contract/LockAsset.json";

import { PluginRegistry } from "@hyperledger/cactus-core";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import bodyParser from "body-parser";

import http, { Server } from "http";
import { Server as SocketIoServer } from "socket.io";

import express from "express";
import { AddressInfo } from "net";
import { v4 as uuidv4 } from "uuid";
import {
  BesuTestLedger,
  pruneDockerAllIfGithubAction,
  Containers,
} from "@hyperledger/cactus-test-tooling";
import { Constants } from "@hyperledger/cactus-core-api";
import {
  Web3SigningCredentialType,
  PluginLedgerConnectorBesu,
  EthContractInvocationType,
  ReceiptType,
  IPluginLedgerConnectorBesuOptions,
  Web3SigningCredential,
} from "@hyperledger/cactus-plugin-ledger-connector-besu";
import Web3 from "web3";
import { Account } from "web3-core";
import {
  PluginBungeeHermes,
  IPluginBungeeHermesOptions,
} from "../../../main/typescript/plugin-bungee-hermes";

import {
  BesuNetworkDetails,
  StrategyBesu,
} from "../../../main/typescript/strategy/strategy-besu";

const logLevel: LogLevelDesc = "INFO";

let besuLedger: BesuTestLedger;
let contractName: string;
//let besuServer: Server;

let rpcApiHttpHost: string;
let rpcApiWsHost: string;
let web3: Web3;
let firstHighNetWorthAccount: string;
let connector: PluginLedgerConnectorBesu;
let besuKeyPair: { privateKey: string };
let testEthAccount: Account;
const BESU_ASSET_ID = uuidv4();

const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "BUNGEE - Hermes",
});
let besuPath: string;
let pluginBungeeHermesOptions: IPluginBungeeHermesOptions;
let besuServer: Server;

let bungeeSigningCredential: Web3SigningCredential;
let bungeeKeychainId: string;
let bungeeContractAddress: string;

let keychainPlugin: PluginKeychainMemory;

let networkDetailsList: BesuNetworkDetails[];

beforeEach(async () => {
  pruneDockerAllIfGithubAction({ logLevel })
    .then(() => {
      log.info("Pruning throw OK");
    })
    .catch(async () => {
      await Containers.logDiagnostics({ logLevel });
      fail("Pruning didn't throw OK");
    });

  {
    besuLedger = new BesuTestLedger({
      logLevel,
      emitContainerLogs: true,
      envVars: ["BESU_NETWORK=dev"],
    });
    await besuLedger.start();

    rpcApiHttpHost = await besuLedger.getRpcApiHttpHost();
    rpcApiWsHost = await besuLedger.getRpcApiWsHost();
    web3 = new Web3(rpcApiHttpHost);
    firstHighNetWorthAccount = besuLedger.getGenesisAccountPubKey();

    testEthAccount = await besuLedger.createEthTestAccount();

    besuKeyPair = {
      privateKey: besuLedger.getGenesisAccountPrivKey(),
    };

    contractName = "LockAsset";

    const keychainEntryValue = besuKeyPair.privateKey;
    const keychainEntryKey = uuidv4();
    keychainPlugin = new PluginKeychainMemory({
      instanceId: uuidv4(),
      keychainId: uuidv4(),

      backend: new Map([[keychainEntryKey, keychainEntryValue]]),
      logLevel,
    });
    keychainPlugin.set(
      LockAssetContractJson.contractName,
      JSON.stringify(LockAssetContractJson),
    );

    const pluginRegistry = new PluginRegistry({
      plugins: [keychainPlugin],
    });

    const options: IPluginLedgerConnectorBesuOptions = {
      instanceId: uuidv4(),
      rpcApiHttpHost,
      rpcApiWsHost,
      pluginRegistry,
      logLevel,
    };
    connector = new PluginLedgerConnectorBesu(options);
    pluginRegistry.add(connector);

    const expressApp = express();
    expressApp.use(bodyParser.json({ limit: "250mb" }));
    besuServer = http.createServer(expressApp);
    const listenOptions: IListenOptions = {
      hostname: "127.0.0.1",
      port: 4000,
      server: besuServer,
    };
    const addressInfo = (await Servers.listen(listenOptions)) as AddressInfo;
    const { address, port } = addressInfo;

    await connector.getOrCreateWebServices();
    const wsApi = new SocketIoServer(besuServer, {
      path: Constants.SocketIoConnectionPathV1,
    });
    await connector.registerWebServices(expressApp, wsApi);
    besuPath = `http://${address}:${port}`;

    await connector.transact({
      web3SigningCredential: {
        ethAccount: firstHighNetWorthAccount,
        secret: besuKeyPair.privateKey,
        type: Web3SigningCredentialType.PrivateKeyHex,
      },
      consistencyStrategy: {
        blockConfirmations: 0,
        receiptType: ReceiptType.NodeTxPoolAck,
      },
      transactionConfig: {
        from: firstHighNetWorthAccount,
        to: testEthAccount.address,
        value: 10e9,
        gas: 1000000,
      },
    });
    const balance = await web3.eth.getBalance(testEthAccount.address);
    expect(balance).toBeTruthy();
    expect(parseInt(balance, 10)).toBeGreaterThan(10e9);

    log.info("Connector initialized");

    const deployOut = await connector.deployContract({
      keychainId: keychainPlugin.getKeychainId(),
      contractName: LockAssetContractJson.contractName,
      contractAbi: LockAssetContractJson.abi,
      constructorArgs: [],
      web3SigningCredential: {
        ethAccount: firstHighNetWorthAccount,
        secret: besuKeyPair.privateKey,
        type: Web3SigningCredentialType.PrivateKeyHex,
      },
      bytecode: LockAssetContractJson.bytecode,
      gas: 1000000,
    });
    expect(deployOut).toBeTruthy();
    expect(deployOut.transactionReceipt).toBeTruthy();
    expect(deployOut.transactionReceipt.contractAddress).toBeTruthy();
    log.info("Contract Deployed successfully");

    const res = await connector.invokeContract({
      contractName,
      keychainId: keychainPlugin.getKeychainId(),
      invocationType: EthContractInvocationType.Send,
      methodName: "createAsset",
      params: [BESU_ASSET_ID, 19],
      signingCredential: {
        ethAccount: firstHighNetWorthAccount,
        secret: besuKeyPair.privateKey,
        type: Web3SigningCredentialType.PrivateKeyHex,
      },
      gas: 1000000,
    });
    expect(res).toBeTruthy();
    expect(res.success).toBeTruthy();

    const res3 = await connector.invokeContract({
      contractName,
      keychainId: keychainPlugin.getKeychainId(),
      invocationType: EthContractInvocationType.Call,
      methodName: "getAsset",
      params: [BESU_ASSET_ID],
      signingCredential: {
        ethAccount: firstHighNetWorthAccount,
        secret: besuKeyPair.privateKey,
        type: Web3SigningCredentialType.PrivateKeyHex,
      },
      gas: 1000000,
    });
    expect(res3).toBeTruthy();
    expect(res3.success).toBeTruthy();
    expect(res3.callOutput.toString()).toBeTruthy();

    bungeeSigningCredential = {
      ethAccount: firstHighNetWorthAccount,
      secret: besuKeyPair.privateKey,
      type: Web3SigningCredentialType.PrivateKeyHex,
    };
    bungeeKeychainId = keychainPlugin.getKeychainId();

    bungeeContractAddress = deployOut.transactionReceipt
      .contractAddress as string;

    pluginBungeeHermesOptions = {
      pluginRegistry,
      keyPair: Secp256k1Keys.generateKeyPairsBuffer(),
      instanceId: uuidv4(),
      logLevel,
    };
  }
  networkDetailsList = [
    {
      signingCredential: bungeeSigningCredential,
      contractName,
      connectorApiPath: besuPath,
      keychainId: bungeeKeychainId,
      contractAddress: bungeeContractAddress,
      participant: firstHighNetWorthAccount,
    } as BesuNetworkDetails,
    {
      signingCredential: bungeeSigningCredential,
      contractName,
      connector: connector,
      keychainId: bungeeKeychainId,
      contractAddress: bungeeContractAddress,
      participant: firstHighNetWorthAccount,
    } as BesuNetworkDetails,
  ];
});

test.each([/*{ apiPath: true }, */ { apiPath: false }])(
  //test for both BesuApiPath and BesuConnector
  "test creation of views for different timeframes and states using",
  async ({ apiPath }) => {
    let networkDetails: BesuNetworkDetails;
    if (apiPath) {
      networkDetails = networkDetailsList[0];
    } else {
      networkDetails = networkDetailsList[1];
    }
    const bungee = new PluginBungeeHermes(pluginBungeeHermesOptions);
    const strategy = "BESU";
    bungee.addStrategy(strategy, new StrategyBesu("INFO"));

    const snapshot = await bungee.generateSnapshot(
      [],
      strategy,
      networkDetails,
    );
    const view = bungee.generateView(
      snapshot,
      "0",
      Number.MAX_SAFE_INTEGER.toString(),
      undefined,
    );
    //expect to return a view
    expect(view.view).toBeTruthy();
    expect(view.signature).toBeTruthy();

    //expect the view to have capture the new asset BESU_ASSET_ID, and attributes to match
    expect(snapshot.getStateBins().length).toEqual(1);
    expect(snapshot.getStateBins()[0].getId()).toEqual(BESU_ASSET_ID);
    expect(snapshot.getStateBins()[0].getTransactions().length).toEqual(1);

    const view1 = bungee.generateView(snapshot, "0", "9999", undefined);

    //expects nothing to limit time of 9999
    expect(view1.view).toBeUndefined();
    expect(view1.signature).toBeUndefined();

    //changing BESU_ASSET_ID value
    const lockAsset = await connector?.invokeContract({
      contractName,
      keychainId: keychainPlugin.getKeychainId(),
      invocationType: EthContractInvocationType.Send,
      methodName: "lockAsset",
      params: [BESU_ASSET_ID],
      signingCredential: {
        ethAccount: firstHighNetWorthAccount,
        secret: besuKeyPair.privateKey,
        type: Web3SigningCredentialType.PrivateKeyHex,
      },
      gas: 1000000,
    });
    expect(lockAsset).not.toBeUndefined();
    expect(lockAsset.success).toBeTrue();

    //creating new asset
    const new_asset_id = uuidv4();
    const depNew = await connector?.invokeContract({
      contractName,
      keychainId: keychainPlugin.getKeychainId(),
      invocationType: EthContractInvocationType.Send,
      methodName: "createAsset",
      params: [new_asset_id, 10],
      signingCredential: {
        ethAccount: firstHighNetWorthAccount,
        secret: besuKeyPair.privateKey,
        type: Web3SigningCredentialType.PrivateKeyHex,
      },
      gas: 1000000,
    });
    expect(depNew).not.toBeUndefined();
    expect(depNew.success).toBeTrue();

    const snapshot1 = await bungee.generateSnapshot(
      [],
      strategy,
      networkDetails,
    );
    const view2 = bungee.generateView(
      snapshot1,
      "0",
      Number.MAX_SAFE_INTEGER.toString(),
      undefined,
    );
    //expect to return a view
    expect(view2.view).toBeTruthy();
    expect(view2.signature).toBeTruthy();

    const stateBins = snapshot1.getStateBins();
    expect(stateBins.length).toEqual(2); //expect to have captured state for both assets

    const bins = [stateBins[0].getId(), stateBins[1].getId()];

    //checks if values match:
    //  - new value of BESU_ASSET_ID state in new snapshot different than value from old snapshot)
    //  - successfully captured transaction that created the new asset
    if (bins[0] === BESU_ASSET_ID) {
      expect(snapshot1.getStateBins()[0].getTransactions().length).toEqual(2);
      expect(snapshot1.getStateBins()[0].getValue()).not.toEqual(
        snapshot.getStateBins()[0].getValue(),
      );
      expect(snapshot1.getStateBins()[1].getTransactions().length).toEqual(1);
    } else {
      expect(snapshot1.getStateBins()[0].getTransactions().length).toEqual(1);
      expect(snapshot1.getStateBins()[1].getTransactions().length).toEqual(2);
      expect(snapshot1.getStateBins()[1].getValue()).not.toEqual(
        snapshot.getStateBins()[0].getValue(),
      );
    }

    async function lock() {
      return await connector?.invokeContract({
        contractName,
        keychainId: keychainPlugin.getKeychainId(),
        invocationType: EthContractInvocationType.Send,
        methodName: "lockAsset",
        params: [BESU_ASSET_ID],
        signingCredential: {
          ethAccount: firstHighNetWorthAccount,
          secret: besuKeyPair.privateKey,
          type: Web3SigningCredentialType.PrivateKeyHex,
        },
        gas: 1000000,
      });
    }
    async function unlock() {
      return await connector?.invokeContract({
        contractName,
        keychainId: keychainPlugin.getKeychainId(),
        invocationType: EthContractInvocationType.Send,
        methodName: "unLockAsset",
        params: [BESU_ASSET_ID],
        signingCredential: {
          ethAccount: firstHighNetWorthAccount,
          secret: besuKeyPair.privateKey,
          type: Web3SigningCredentialType.PrivateKeyHex,
        },
        gas: 1000000,
      });
    }
    const snaptime = [];
    const viewtime = [];
    const transactions = [
      5, 10, 20, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100,
      1200,
    ];
    //at this point BESU_ASSET_ID has 2 transactions
    //asset is locked
    let locked = true;
    async function spanNTransactions(n: number) {
      for (let index = 0; index < n; index++) {
        if (locked) {
          await unlock();
          locked = false;
        } else {
          await lock();
          locked = true;
        }
      }
    }

    await spanNTransactions(3);
    let time = Date.now();
    let snapshot3 = await bungee.generateSnapshot(
      [BESU_ASSET_ID],
      strategy,
      networkDetails,
    );
    snaptime.push(Date.now() - time);
    time = Date.now();
    let view3 = bungee.generateView(
      snapshot1,
      "0",
      Number.MAX_SAFE_INTEGER.toString(),
      undefined,
    );
    viewtime.push(Date.now() - time);
    expect(view3.view).toBeTruthy();
    expect(view3.signature).toBeTruthy();
    expect(snapshot3.getStateBins()[0].getTransactions().length).toEqual(5);
    for (let index = 1; index < transactions.length; index++) {
      await spanNTransactions(transactions[index] - transactions[index - 1]);
      time = Date.now();
      snapshot3 = await bungee.generateSnapshot(
        [BESU_ASSET_ID],
        strategy,
        networkDetails,
      );
      snaptime.push(Date.now() - time);
      time = Date.now();
      view3 = bungee.generateView(
        snapshot1,
        "0",
        Number.MAX_SAFE_INTEGER.toString(),
        undefined,
      );
      viewtime.push(Date.now() - time);
      expect(view3.view).toBeTruthy();
      expect(view3.signature).toBeTruthy();
      expect(snapshot3.getStateBins()[0].getTransactions().length).toEqual(
        transactions[index],
      );
    }

    await createGraph(transactions, snaptime, viewtime, "Bungee-Besu2");
  },
);

afterEach(async () => {
  await Servers.shutdown(besuServer);
  await besuLedger.stop();
  await besuLedger.destroy();

  await pruneDockerAllIfGithubAction({ logLevel })
    .then(() => {
      log.info("Pruning throw OK");
    })
    .catch(async () => {
      await Containers.logDiagnostics({ logLevel });
      fail("Pruning didn't throw OK");
    });
});

async function createGraph(
  data: number[],
  data1: number[],
  data2: number[],
  filename: string,
) {
  const width = 1600; // Width of the image
  const height = 800; // Height of the image
  log.info(data);
  log.info(data1);
  log.info(data2);
  const data3 = [];
  const data4 = [];
  for (let index = 0; index < data2.length; index++) {
    data3.push(data1[index] + data2[index]);
    data4.push(data1[index] / data3[index]);
  }
  log.info(data3);
  log.info(data4);
  const chartJSNodeCanvas = new ChartJSNodeCanvas({
    width,
    height,
    backgroundColour: "white",
  });
  const { slope, intercept, r2 } = calculateLinearRegression(data, data3);
  const data5 = data.map((x) => {
    return x * slope + intercept;
  });
  const configuration = {
    type: "line" as const,
    data: {
      labels: data.map((n) => {
        return n.toString();
      }),
      datasets: [
        {
          label: "Snapshot Time",
          data: data1,
          borderColor: "rgba(0, 0, 255, 1)",
          backgroundColor: "rgba(0, 0, 255, 0.2)",
          borderWidth: 2,
          tension: 0.4,
        },
        {
          label: "View Time",
          data: data2,
          borderColor: "rgba(255, 0, 0, 1)",
          backgroundColor: "rgba(255, 0, 0, 0.2)",
          borderWidth: 2,
          tension: 0.4,
        },
        {
          label: "Total Time",
          data: data3,
          borderColor: "rgba(0, 255, 0, 1)",
          backgroundColor: "rgba(0, 255, 0, 0.2)",
          borderWidth: 2,
          tension: 0.4,
        },
        {
          label: "Linear Regression: R2=" + r2.toFixed(2).toString(),
          data: data5,
          borderColor: "rgba(0, 0, 0, 0.5)",
          borderDash: [15, 5],
          borderWidth: 2,
          tension: 0.4,
          fill: false,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: "BUNGEE performance Besu",
          font: {
            size: 28, // Larger title font size
            family: "Arial",
            weight: "bold",
          },
        },
        legend: {
          labels: {
            color: "#333",
            font: {
              size: 22,
            },
            // Custom function to add the average to the legend
            generateLabels: (chart: any) => {
              const originalLegend = chart.data.datasets.map(
                (dataset: any, i: any) => {
                  return {
                    text: `${dataset.label}`,
                    fillStyle: dataset.backgroundColor,
                    //strokeStyle: dataset.borderColor,
                    lineWidth: dataset.borderWidth,
                    hidden: !chart.isDatasetVisible(i),
                    datasetIndex: i,
                  };
                },
              );

              return originalLegend;
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: {
            color: "rgba(200, 200, 200, 0.2)", // Light grid lines
          },
          ticks: {
            color: "#333",
            font: {
              size: 18, // Larger y-axis label font size
            },
          },
        },
        x: {
          type: "linear" as const,
          grid: {
            color: "rgba(200, 200, 200, 0.2)", // Light grid lines
          },
          ticks: {
            color: "#333",
            font: {
              size: 18, // Larger x-axis label font size
            },
          },
        },
      },
    },
  };
  const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);

  // Save the image buffer to a file
  fs.writeFileSync("./" + filename + ".png", imageBuffer);

  console.log("Chart has been saved");
}

function calculateLinearRegression(
  x: number[],
  y: number[],
): { slope: number; intercept: number; r2: number } {
  const n = x.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (const X of x) sumX += X;
  for (const Y of y) sumY += Y;
  for (let i = 0; i < n; i++) sumXY += x[i] * y[i];
  for (const X of x) sumX2 += X * X;
  //const sumY2 = y.reduce((acc, val) => acc + val * val, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  // Calculate R²
  const yMean = sumY / n;
  let ssTot = 0;
  for (const Y of y) ssTot += Math.pow(Y - yMean, 2);
  let ssRes = 0;
  for (let i = 0; i < x.length; i++) {
    ssRes += Math.pow(y[i] - (slope * x[i] + intercept), 2);
  }
  const r2 = 1 - ssRes / ssTot;
  log.info(slope, intercept, r2);
  return { slope, intercept, r2 };
}
