import { LogLevelDesc, LoggerProvider } from "@hyperledger/cactus-common";
import {
  pruneDockerAllIfGithubAction,
  Containers,
} from "@hyperledger/cactus-test-tooling";
import { CbdcBridgingApp } from "../../../main/typescript";
import { ICbdcBridgingApp } from "../../../main/typescript/cbdc-bridging-app";

const logLevel: LogLevelDesc = "DEBUG";

const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "BUNGEE - Hermes",
});
beforeAll(async () => {
  pruneDockerAllIfGithubAction({ logLevel })
    .then(() => {
      log.info("Pruning throw OK");
    })
    .catch(async () => {
      await Containers.logDiagnostics({ logLevel });
      fail("Pruning didn't throw OK");
    });
});

afterAll(async () => {
  await pruneDockerAllIfGithubAction({ logLevel })
    .then(() => {
      log.info("Pruning throw OK");
    })
    .catch(async () => {
      await Containers.logDiagnostics({ logLevel });
      fail("Pruning didn't throw OK");
    });
});

describe("Setup CBDC app infrastructure", () => {
  let app: CbdcBridgingApp;
  it("Should setup everything successfully", async () => {
    const options: ICbdcBridgingApp = {
      apiServer1Port: 4000,
      apiServer2Port: 4100,
      apiHost: "localhost",
      apiServer1CrpcPort: 6000,
      apiServer2CrpcPort: 6100,
      apiCrpcHost: "localhost",
      logLevel,
    };
    app = new CbdcBridgingApp(options);
    expect(app).toBeDefined();

    await app.start();
  });

  it("Should shutdown everything successfully", async () => {
    await app.stop();
  });
});
