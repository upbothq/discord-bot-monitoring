import { defineConfig } from "bunup";

export default defineConfig({
	// otel and register are separate entries: the main entry must not load the OpenTelemetry SDK
	entry: ["src/index.ts", "src/otel.ts", "src/register.ts"],
	format: ["esm", "cjs"],
	dts: true,
	clean: true,
});
