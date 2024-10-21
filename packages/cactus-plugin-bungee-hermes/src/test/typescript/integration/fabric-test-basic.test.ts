import {
  IListenOptions,
  LogLevelDesc,
  LoggerProvider,
  Secp256k1Keys,
  Servers,
} from "@hyperledger/cactus-common";
import "jest-extended";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";

import { PluginRegistry } from "@hyperledger/cactus-core";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { DiscoveryOptions } from "fabric-network";
import bodyParser from "body-parser";
import path from "path";

import http, { Server } from "http";

import fs from "fs-extra";

import {
  Configuration,
  DefaultEventHandlerStrategy,
  FabricSigningCredential,
  IPluginLedgerConnectorFabricOptions,
  PluginLedgerConnectorFabric,
  DefaultApi as FabricApi,
  FileBase64,
  ChainCodeProgrammingLanguage,
  FabricContractInvocationType,
} from "@hyperledger/cactus-plugin-ledger-connector-fabric";
import {
  Containers,
  FABRIC_25_LTS_AIO_FABRIC_VERSION,
  FABRIC_25_LTS_AIO_IMAGE_VERSION,
  FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
  FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_2,
  FabricTestLedgerV1,
  pruneDockerAllIfGithubAction,
} from "@hyperledger/cactus-test-tooling";
import express from "express";
import { AddressInfo } from "net";

import { v4 as uuidv4 } from "uuid";
import {
  PluginBungeeHermes,
  IPluginBungeeHermesOptions,
} from "../../../main/typescript/plugin-bungee-hermes";
import {
  FabricNetworkDetails,
  StrategyFabric,
} from "../../../main/typescript/strategy/strategy-fabric";

let fabricServer: Server;

let fabricSigningCredential: FabricSigningCredential;
const logLevel: LogLevelDesc = "INFO";

let fabricLedger: FabricTestLedgerV1;
let fabricContractName: string;
let fabricChannelName: string;
let fabricPath: string;

let configFabric: Configuration;
let apiClient: FabricApi;

let fabricConnector: PluginLedgerConnectorFabric;
let pluginBungeeFabricOptions: IPluginBungeeHermesOptions;
let pluginBungee: PluginBungeeHermes;
const FABRIC_ASSET_ID = uuidv4();

let networkDetailsList: FabricNetworkDetails[];

const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "BUNGEE - Hermes",
});

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
    // Fabric ledger connection
    const channelId = "mychannel";
    fabricChannelName = channelId;

    fabricLedger = new FabricTestLedgerV1({
      emitContainerLogs: true,
      publishAllPorts: true,
      imageName: "ghcr.io/hyperledger/cactus-fabric2-all-in-one",
      imageVersion: FABRIC_25_LTS_AIO_IMAGE_VERSION,
      envVars: new Map([["FABRIC_VERSION", FABRIC_25_LTS_AIO_FABRIC_VERSION]]),
      logLevel,
    });

    await fabricLedger.start();
    log.info("Fabric Ledger started");

    const connectionProfile = await fabricLedger.getConnectionProfileOrg1();
    expect(connectionProfile).not.toBeUndefined();

    const enrollAdminOut = await fabricLedger.enrollAdmin();
    const adminWallet = enrollAdminOut[1];
    const [userIdentity] = await fabricLedger.enrollUser(adminWallet);
    const sshConfig = await fabricLedger.getSshConfig();

    log.info("enrolled admin");

    const keychainInstanceId = uuidv4();
    const keychainId = uuidv4();
    const keychainEntryKey = "user1";
    const keychainEntryValue = JSON.stringify(userIdentity);

    const keychainPlugin = new PluginKeychainMemory({
      instanceId: keychainInstanceId,
      keychainId,
      logLevel,
      backend: new Map([
        [keychainEntryKey, keychainEntryValue],
        ["some-other-entry-key", "some-other-entry-value"],
      ]),
    });

    const pluginRegistry = new PluginRegistry({ plugins: [keychainPlugin] });

    const discoveryOptions: DiscoveryOptions = {
      enabled: true,
      asLocalhost: true,
    };

    const pluginOptions: IPluginLedgerConnectorFabricOptions = {
      instanceId: uuidv4(),
      dockerBinary: "/usr/local/bin/docker",
      peerBinary: "/fabric-samples/bin/peer",
      goBinary: "/usr/local/go/bin/go",
      pluginRegistry,
      cliContainerEnv: FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
      sshConfig,
      logLevel: "INFO",
      connectionProfile,
      discoveryOptions,
      eventHandlerOptions: {
        strategy: DefaultEventHandlerStrategy.NetworkScopeAllfortx,
        commitTimeout: 300,
      },
    };

    fabricConnector = new PluginLedgerConnectorFabric(pluginOptions);

    const expressApp = express();
    expressApp.use(bodyParser.json({ limit: "250mb" }));
    fabricServer = http.createServer(expressApp);
    const listenOptions: IListenOptions = {
      hostname: "127.0.0.1",
      port: 3000,
      server: fabricServer,
    };
    const addressInfo = (await Servers.listen(listenOptions)) as AddressInfo;
    const { address, port } = addressInfo;

    await fabricConnector.getOrCreateWebServices();
    await fabricConnector.registerWebServices(expressApp);

    log.info("Fabric Ledger connector check");

    const apiUrl = `http://${address}:${port}`;

    fabricPath = apiUrl;
    configFabric = new Configuration({ basePath: apiUrl });

    apiClient = new FabricApi(configFabric);

    // deploy contracts ...
    fabricContractName = "basic-asset-transfer-2";
    const contractRelPath =
      "../fabric-contracts/simple-asset/chaincode-typescript";
    const contractDir = path.join(__dirname, contractRelPath);

    // ├── package.json
    // ├── src
    // │   ├── assetTransfer.ts
    // │   ├── asset.ts
    // │   ├── index.ts
    // │   └── ITraceableContract.ts
    // ├── tsconfig.json
    // --------
    const sourceFiles: FileBase64[] = [];
    {
      const filename = "./tsconfig.json";
      const relativePath = "./";
      const filePath = path.join(contractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      sourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }
    {
      const filename = "./package.json";
      const relativePath = "./";
      const filePath = path.join(contractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      sourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }
    {
      const filename = "./index.ts";
      const relativePath = "./src/";
      const filePath = path.join(contractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      sourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }
    {
      const filename = "./asset.ts";
      const relativePath = "./src/";
      const filePath = path.join(contractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      sourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }
    {
      const filename = "./assetTransfer.ts";
      const relativePath = "./src/";
      const filePath = path.join(contractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      sourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }
    {
      const filename = "./ITraceableContract.ts";
      const relativePath = "./src/";
      const filePath = path.join(contractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      sourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }

    const res = await apiClient.deployContractV1({
      channelId,
      ccVersion: "1.0.0",
      sourceFiles,
      ccName: fabricContractName,
      targetOrganizations: [
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_2,
      ],
      caFile:
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1.ORDERER_TLS_ROOTCERT_FILE,
      ccLabel: "basic-asset-transfer-2",
      ccLang: ChainCodeProgrammingLanguage.Typescript,
      ccSequence: 1,
      orderer: "orderer.example.com:7050",
      ordererTLSHostnameOverride: "orderer.example.com",
      connTimeout: 60,
    });

    const { packageIds, lifecycle, success } = res.data;
    expect(res.status).toBe(200);
    expect(success).toBe(true);
    expect(lifecycle).not.toBeUndefined();

    const {
      approveForMyOrgList,
      installList,
      queryInstalledList,
      commit,
      packaging,
      queryCommitted,
    } = lifecycle;

    expect(packageIds).toBeTruthy();
    expect(packageIds).toBeArray();

    expect(approveForMyOrgList).toBeTruthy();
    expect(approveForMyOrgList).toBeArray();

    expect(installList).toBeTruthy();
    expect(installList).toBeArray();
    expect(queryInstalledList).toBeTruthy();
    expect(queryInstalledList).toBeArray();

    expect(commit).toBeTruthy();
    expect(packaging).toBeTruthy();
    expect(queryCommitted).toBeTruthy();
    log.info("Contract deployed");

    fabricSigningCredential = {
      keychainId,
      keychainRef: keychainEntryKey,
    };
    const createResponse = await apiClient.runTransactionV1({
      contractName: fabricContractName,
      channelName: fabricChannelName,
      params: [FABRIC_ASSET_ID, "19"],
      methodName: "CreateAsset",
      invocationType: FabricContractInvocationType.Send,
      signingCredential: fabricSigningCredential,
    });

    expect(createResponse).not.toBeUndefined();
    expect(createResponse.status).toBeGreaterThan(199);
    expect(createResponse.status).toBeLessThan(300);

    log.info(
      `BassicAssetTransfer.Create(): ${JSON.stringify(createResponse.data)}`,
    );

    pluginBungeeFabricOptions = {
      pluginRegistry,
      keyPair: Secp256k1Keys.generateKeyPairsBuffer(),
      instanceId: uuidv4(),
    };

    networkDetailsList = [
      {
        connectorApiPath: fabricPath,
        signingCredential: fabricSigningCredential,
        channelName: fabricChannelName,
        contractName: fabricContractName,
        participant: "Org1MSP",
      },
      {
        connector: fabricConnector,
        signingCredential: fabricSigningCredential,
        channelName: fabricChannelName,
        contractName: fabricContractName,
        participant: "Org1MSP",
      },
    ];

    pluginBungee = new PluginBungeeHermes(pluginBungeeFabricOptions);
  }
});

test.each([{ apiPath: false }])(
  //test for both FabricApiPath and FabricConnector
  "test creation of views for different timeframes and states",
  async ({ apiPath }) => {
    let networkDetails: FabricNetworkDetails;
    if (apiPath) {
      networkDetails = networkDetailsList[0];
    } else {
      networkDetails = networkDetailsList[1];
    }

    const strategy = "FABRIC";
    pluginBungee.addStrategy(strategy, new StrategyFabric("INFO"));

    const snapshot = await pluginBungee.generateSnapshot(
      [],
      strategy,
      networkDetails,
    );
    const view = pluginBungee.generateView(
      snapshot,
      "0",
      Number.MAX_SAFE_INTEGER.toString(),
      undefined,
    );

    //expect to return a view
    expect(view.view).toBeTruthy();
    expect(view.signature).toBeTruthy();

    //expect the view to have capture the new asset Fabric_ASSET_ID, and attributes to match
    expect(snapshot.getStateBins().length).toEqual(1);
    expect(snapshot.getStateBins()[0].getId()).toEqual(FABRIC_ASSET_ID);
    expect(snapshot.getStateBins()[0].getTransactions().length).toEqual(1);

    //fabric transaction proofs include endorsements
    expect(
      snapshot
        .getStateBins()[0]
        .getTransactions()[0]
        .getProof()
        .getEndorsements()?.length,
    ).toEqual(2);

    //no valid states for this time frame
    const view1 = pluginBungee.generateView(snapshot, "0", "9999", undefined);
    expect(view1.view).toBeUndefined();
    expect(view1.signature).toBeUndefined();

    //creating new asset
    const new_asset_id = uuidv4();
    const createResponse = await apiClient.runTransactionV1({
      contractName: fabricContractName,
      channelName: fabricChannelName,
      params: [new_asset_id, "10"],
      methodName: "CreateAsset",
      invocationType: FabricContractInvocationType.Send,
      signingCredential: fabricSigningCredential,
    });
    expect(createResponse).not.toBeUndefined();
    expect(createResponse.status).toBeGreaterThan(199);
    expect(createResponse.status).toBeLessThan(300);

    //changing FABRIC_ASSET_ID value
    const modifyResponse = await apiClient.runTransactionV1({
      contractName: fabricContractName,
      channelName: fabricChannelName,
      params: [FABRIC_ASSET_ID, "18"],
      methodName: "UpdateAsset",
      invocationType: FabricContractInvocationType.Send,
      signingCredential: fabricSigningCredential,
    });
    expect(modifyResponse).not.toBeUndefined();
    expect(modifyResponse.status).toBeGreaterThan(199);
    expect(modifyResponse.status).toBeLessThan(300);

    const snapshot1 = await pluginBungee.generateSnapshot(
      [],
      strategy,
      networkDetails,
    );
    const view2 = pluginBungee.generateView(
      snapshot1,
      "0",
      Number.MAX_SAFE_INTEGER.toString(),
      undefined,
    );

    //expect to return a view
    expect(view2.view).toBeTruthy();
    expect(view2.signature).toBeTruthy();

    //expect to have captured state for both assets
    const stateBins = snapshot1.getStateBins();
    expect(stateBins.length).toEqual(2);
    const bins = [stateBins[0].getId(), stateBins[1].getId()];

    expect(bins.includes(FABRIC_ASSET_ID)).toBeTrue();
    expect(bins.includes(new_asset_id)).toBeTrue();

    //checks if values match:
    //  - new value of FABRIC_ASSET_ID state in new snapshot equals to new value)
    //  - successfully captured transaction that created the new asset
    if (bins[0] === FABRIC_ASSET_ID) {
      expect(snapshot1.getStateBins()[0].getTransactions().length).toEqual(2);
      expect(snapshot1.getStateBins()[0].getValue()).toEqual("18");
      expect(snapshot1.getStateBins()[1].getTransactions().length).toEqual(1);
    } else {
      expect(snapshot1.getStateBins()[0].getTransactions().length).toEqual(1);
      expect(snapshot1.getStateBins()[1].getTransactions().length).toEqual(2);
      expect(snapshot1.getStateBins()[1].getValue()).toEqual("18");
    }

    async function change() {
      //changing FABRIC_ASSET_ID value
      return await apiClient.runTransactionV1({
        contractName: fabricContractName,
        channelName: fabricChannelName,
        params: [
          FABRIC_ASSET_ID,
          Math.floor(Math.random() * 1000000).toString(),
        ],
        methodName: "UpdateAsset",
        invocationType: FabricContractInvocationType.Send,
        signingCredential: fabricSigningCredential,
      });
    }
    const snaptime = [];
    const viewtime = [];
    const transactions = [
      5, 10, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200,
    ]; /*, 300, 400, 500, 600, 700, 800, 900, 1000, 1100,
      1200,
    ];*/
    //at this point FABRIC_ASSET_ID has 2 transactions
    async function spanNTransactions(n: number) {
      for (let index = 0; index < n; index++) {
        await change();
      }
    }

    await spanNTransactions(3);
    let time = Date.now();
    let snapshot3 = await pluginBungee.generateSnapshot(
      [FABRIC_ASSET_ID],
      strategy,
      networkDetails,
    );
    snaptime.push(Date.now() - time);
    time = Date.now();
    let view3 = pluginBungee.generateView(
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
      snapshot3 = await pluginBungee.generateSnapshot(
        [FABRIC_ASSET_ID],
        strategy,
        networkDetails,
      );
      snaptime.push(Date.now() - time);
      time = Date.now();
      view3 = pluginBungee.generateView(
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

    await createGraph(transactions, snaptime, viewtime, "Bungee-Fabric");
  },
  1000 * 60 * 60 * 3,
);

afterEach(async () => {
  await fabricLedger.stop();
  await fabricLedger.destroy();
  await Servers.shutdown(fabricServer);

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
          text: "BUNGEE performance Fabric",
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
