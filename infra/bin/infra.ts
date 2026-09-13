#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { LineupAnnouncerStack } from "../lib/lineup-announcer-stack";

const app = new cdk.App();
new LineupAnnouncerStack(app, "LineupAnnouncerStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "us-east-1",
  },
});
