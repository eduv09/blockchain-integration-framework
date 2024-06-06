import "jest-extended";
import {
  Containers,
  pruneDockerAllIfGithubAction,
} from "@hyperledger/cactus-test-tooling";
import {
  LogLevelDesc,
  LoggerProvider,
  Servers,
} from "@hyperledger/cactus-common";
import { TransactionApi as SATPTransactionApi } from "../../../main/typescript/public-api";
import {
  generateKeyPair,
  exportSPKI,
  exportPKCS8,
  GenerateKeyPairResult,
} from "jose";
import { ApiClient } from "@hyperledger/cactus-api-client";
import { v4 as uuidV4 } from "uuid";
import {
  IPluginFactoryOptions,
  Ledger,
  LedgerType,
  PluginImportType,
} from "@hyperledger/cactus-core-api";
import {
  CactusNode,
  Consortium,
  ConsortiumDatabase,
  ConsortiumMember,
} from "@hyperledger/cactus-core-api";
import {
  ApiServer,
  AuthorizationProtocol,
  ConfigService,
} from "@hyperledger/cactus-cmd-api-server";
import {
  IPluginConsortiumManualOptions,
  PluginConsortiumManual,
  Configuration,
} from "@hyperledger/cactus-plugin-consortium-manual";

const logLevel: LogLevelDesc = "INFO";
const logger = LoggerProvider.getOrCreate({
  level: "INFO",
  label: "create consortium",
});

import { AddressInfo } from "net";
import { PluginRegistry } from "@hyperledger/cactus-core";
import {
  SATPGateway,
  SATPGatewayConfig,
} from "../../../main/typescript/plugin-satp-hermes-gateway";
import { SupportedChain } from "../../../main/typescript/core/types";
import { PluginFactorySATPGateway } from "../../../main/typescript/factory/plugin-factory-gateway-orchestrator";
const consortiumId = uuidV4();
const consortiumName = "Example Corp. & Friends Crypto Consortium";

let keyPair1: GenerateKeyPairResult;
let pubKeyPem1: string;
let member1: ConsortiumMember;
let node1: CactusNode;
const memberId1 = uuidV4();
let apiServer1: ApiServer;
let addressInfo1: AddressInfo;
let node1Host: string;
let httpServer1: any;

let keyPair2: GenerateKeyPairResult;
let pubKeyPem2: string;
let member2: ConsortiumMember;
let node2: CactusNode;
const memberId2 = uuidV4();
let apiServer2: ApiServer;
let addressInfo2: AddressInfo;
let node2Host: string;
let httpServer2: any;

let gateway1: SATPGateway;
let gateway2: SATPGateway;

const ledger1: Ledger = {
  id: "DLT1",
  ledgerType: LedgerType.Fabric14X,
};
const ledger2: Ledger = {
  id: "DLT2",
  ledgerType: LedgerType.Fabric14X,
};

const factoryOptions: IPluginFactoryOptions = {
  pluginImportType: PluginImportType.Local,
};
const factory = new PluginFactorySATPGateway(factoryOptions);

beforeAll(async () => {
  pruneDockerAllIfGithubAction({ logLevel })
    .then(() => {
      logger.info("Pruning throw OK");
    })
    .catch(async () => {
      await Containers.logDiagnostics({ logLevel });
      fail("Pruning didn't throw OK");
    });
});

test("create consortium and test api-server routing", async () => {
  const options1: SATPGatewayConfig = {
    logLevel: "INFO",
    gid: {
      id: "mockID1",
      name: "CustomGateway",
      version: [
        {
          Core: "v02",
          Architecture: "v02",
          Crash: "v02",
        },
      ],
      supportedDLTs: [SupportedChain.FABRIC, SupportedChain.BESU],
      proofID: "mockProofID102",
      gatewayServerPort: 3010,
      gatewayClientPort: 3011,
      address: "https://localhost",
    },
  };
  gateway1 = await factory.create(options1);

  const options2: SATPGatewayConfig = {
    logLevel: "INFO",
    gid: {
      id: "mockID2",
      name: "CustomGateway",
      version: [
        {
          Core: "v02",
          Architecture: "v02",
          Crash: "v02",
        },
      ],
      supportedDLTs: [SupportedChain.FABRIC, SupportedChain.BESU],
      proofID: "mockProofID101",
      gatewayServerPort: 3050,
      gatewayClientPort: 3051,
      address: "https://localhost",
    },
  };
  gateway2 = await factory.create(options2);

  await gateway1.startup();
  await gateway2.startup();

  httpServer1 = await Servers.startOnPreferredPort(3010);
  addressInfo1 = httpServer1.address() as AddressInfo;
  node1Host = `http://${addressInfo1.address}:${addressInfo1.port}`;

  httpServer2 = await Servers.startOnPreferredPort(3050);
  addressInfo2 = httpServer2.address() as AddressInfo;
  node2Host = `http://${addressInfo2.address}:${addressInfo2.port}`;

  keyPair1 = await generateKeyPair("ES256K");
  pubKeyPem1 = await exportSPKI(keyPair1.publicKey);

  keyPair2 = await generateKeyPair("ES256K");
  pubKeyPem2 = await exportSPKI(keyPair2.publicKey);

  node1 = {
    nodeApiHost: node1Host,
    publicKeyPem: pubKeyPem1,
    consortiumId,
    id: uuidV4(),
    ledgerIds: [ledger1.id],
    memberId: memberId1,
    pluginInstanceIds: [],
    capabilities: ["org.hyperledger.cactus.capability.SATPHermes"],
  };

  member1 = {
    id: memberId1,
    name: "Example Corp 1",
    nodeIds: [node1.id],
  };

  node2 = {
    nodeApiHost: node2Host,
    publicKeyPem: pubKeyPem2,
    consortiumId,
    id: uuidV4(),
    ledgerIds: [ledger2.id],
    memberId: memberId2,
    pluginInstanceIds: [],
    capabilities: ["org.hyperledger.cactus.capability.SATPHermes"],
  };

  member2 = {
    id: memberId2,
    name: "Example Corp 2",
    nodeIds: [node2.id],
  };

  const consortium: Consortium = {
    id: consortiumId,
    mainApiHost: node1Host,
    name: consortiumName,
    memberIds: [member1.id, member2.id],
  };

  const consortiumDatabase: ConsortiumDatabase = {
    cactusNode: [node1, node2],
    consortium: [consortium],
    consortiumMember: [member1, member2],
    ledger: [ledger1, ledger2],
    pluginInstance: [],
  };

  {
    const pluginRegistry = new PluginRegistry({ plugins: [] });

    const keyPairPem = await exportPKCS8(keyPair1.privateKey);
    const options: IPluginConsortiumManualOptions = {
      instanceId: uuidV4(),
      pluginRegistry,
      keyPairPem: keyPairPem,
      consortiumDatabase,
      logLevel,
    };
    const pluginConsortiumManual = new PluginConsortiumManual(options);

    const configService = new ConfigService();
    const apiServerOptions = await configService.newExampleConfig();
    apiServerOptions.authorizationProtocol = AuthorizationProtocol.NONE;
    apiServerOptions.configFile = "";
    apiServerOptions.apiCorsDomainCsv = "*";
    apiServerOptions.apiPort = addressInfo1.port;
    apiServerOptions.cockpitPort = 0;
    apiServerOptions.grpcPort = 0;
    apiServerOptions.crpcPort = 0;
    apiServerOptions.logLevel = logLevel || "INFO";
    apiServerOptions.apiTlsEnabled = false;
    const config =
      await configService.newExampleConfigConvict(apiServerOptions);

    pluginRegistry.add(pluginConsortiumManual);
    pluginRegistry.add(gateway1);

    apiServer1 = new ApiServer({
      httpServerApi: httpServer1,
      config: config.getProperties(),
      pluginRegistry,
    });

    await apiServer1.start();
    logger.info("initiated api-server 1");
  }

  {
    const pluginRegistry = new PluginRegistry({ plugins: [] });

    const keyPairPem = await exportPKCS8(keyPair2.privateKey);
    const options: IPluginConsortiumManualOptions = {
      instanceId: uuidV4(),
      pluginRegistry,
      keyPairPem: keyPairPem,
      consortiumDatabase,
      logLevel,
    };
    const pluginConsortiumManual = new PluginConsortiumManual(options);

    const configService = new ConfigService();
    const apiServerOptions = await configService.newExampleConfig();
    apiServerOptions.authorizationProtocol = AuthorizationProtocol.NONE;
    apiServerOptions.configFile = "";
    apiServerOptions.apiCorsDomainCsv = "*";
    apiServerOptions.apiPort = addressInfo2.port;
    apiServerOptions.logLevel = logLevel || "INFO";
    apiServerOptions.cockpitPort = 0;
    apiServerOptions.grpcPort = 0;
    apiServerOptions.crpcPort = 0; //default is 6000 , have to change so it does not break
    apiServerOptions.apiTlsEnabled = false;
    const config =
      await configService.newExampleConfigConvict(apiServerOptions);

    pluginRegistry.add(pluginConsortiumManual);
    pluginRegistry.add(gateway2);

    apiServer2 = new ApiServer({
      httpServerApi: httpServer2,
      config: config.getProperties(),
      pluginRegistry,
    });

    await apiServer2.start();
    logger.info("initiated api-server 2");
  }

  const config = new Configuration({ basePath: consortium.mainApiHost });
  const mainApiClient = new ApiClient(config);

  const apiClient1 = await mainApiClient.ofLedger(
    ledger1.id,
    SATPTransactionApi,
    {},
  );

  const apiClient2 = await mainApiClient.ofLedger(
    ledger2.id,
    SATPTransactionApi,
    {},
    undefined,
    ["org.hyperledger.cactus.capability.SATPHermes"],
  );
  logger.info(JSON.stringify(apiClient1));
  logger.info(JSON.stringify(apiClient2));

  expect(JSON.stringify(apiClient1)).not.toEqual(JSON.stringify(apiClient2));
});

afterAll(async () => {
  await gateway1.shutdown();
  await gateway2.shutdown();
  await apiServer2.shutdown();
  await apiServer1.shutdown();
});
