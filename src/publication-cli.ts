#!/usr/bin/env node
import { runPublicationCli } from "./publication.js";

process.exitCode = runPublicationCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
