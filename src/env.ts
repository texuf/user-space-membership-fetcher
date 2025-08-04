import * as dotenv from "dotenv";

// Load environment variables from .env.local
dotenv.config({ path: ".env.local" });

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;

if (!ALCHEMY_API_KEY) {
  throw new Error("ALCHEMY_API_KEY environment variable is not set");
}

export const env = {
  ALCHEMY_API_KEY,
  ENVIRONMENT: process.env.ENVIRONMENT ?? "omega",
};
