import { vi } from "vitest";

vi.stubEnv("PAYPAL_SANDBOX_CLIENT_ID", "fakeClientId");
vi.stubEnv("PAYPAL_SANDBOX_CLIENT_SECRET", "fakeClientSecret");
vi.stubEnv("SPLIT_DATA_FILE", "");
