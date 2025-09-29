import { streamIdAsString } from "@towns-protocol/sdk";

const run = async () => {
  const env = process.env.ENV ?? "omega";
  // Get the wallet address from the command line arguments
  //   const param = process.argv[2];
  //   if (!param) {
  //     console.error("no stream id provided");
  //     process.exit(1);
  //   }

  //

  const bytesStr = "IH1pNrbb53zafZP+zifNu02q3RrHShTe5lU6j4F4jyE=";
  const encoding = "base64";
  try {
    const bytes = Buffer.from(bytesStr, encoding);
    console.log(bytes);
    console.log(streamIdAsString(bytes));
  } catch (e) {
    console.log(`error with encoding ${encoding}: ${e}`);
  }
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("unhandled error:", e);
    process.exit(1);
  });
