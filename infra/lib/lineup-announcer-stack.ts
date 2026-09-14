import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

export class LineupAnnouncerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Holds a single item (id: "roster") whose `players` attribute is the
    // whole ordered lineup array — small, always read/written as one unit,
    // so one item is simpler and more robust than per-player rows here.
    // RETAIN because this is the one piece of real user data in an
    // otherwise fully rebuildable stack; everything else regenerates from
    // this code on redeploy, but a stack replacement shouldn't wipe rosters.
    const table = new dynamodb.TableV2(this, "RosterTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const fn = new lambda.Function(this, "LineupAnnouncerFunction", {
      functionName: "lineup-announcer",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda"),
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: {
        ROSTER_TABLE_NAME: table.tableName,
      },
    });

    table.grantReadWriteData(fn);

    // Polly has no resource-level permissions for SynthesizeSpeech.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["polly:SynthesizeSpeech"],
        resources: ["*"],
      }),
    );

    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    new cdk.CfnOutput(this, "FunctionUrl", {
      value: fnUrl.url,
    });

    // --- CI/CD: GitHub Actions deploys this stack on every push to main ---
    // The role below has almost no direct AWS permissions of its own — it can
    // only assume the CDK bootstrap roles (deploy-role, file-publishing-role,
    // lookup-role), which already trust any principal in this account and
    // hold the actual CloudFormation/S3/etc. permissions `cdk deploy` needs.
    // That's the standard, least-privilege way to wire CI into a bootstrapped
    // CDK app: GitHub never gets broad AWS access, only "act as the same
    // deploy identity a human running `cdk deploy` locally already uses."
    const githubRepo = "gong4494/LineupAnnouncer";

    const githubOidc = new iam.OidcProviderNative(this, "GitHubOidcProvider", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    const deployRole = new iam.Role(this, "GitHubActionsDeployRole", {
      roleName: "github-actions-lineup-announcer-deploy",
      description: "Assumed by GitHub Actions to deploy LineupAnnouncerStack on merge to main",
      assumedBy: new iam.OpenIdConnectPrincipal(githubOidc, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        },
        StringLike: {
          "token.actions.githubusercontent.com:sub": `repo:${githubRepo}:ref:refs/heads/main`,
        },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole", "sts:TagSession"],
        resources: [
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-deploy-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-file-publishing-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-lookup-role-${this.account}-${this.region}`,
        ],
      }),
    );

    new cdk.CfnOutput(this, "GitHubActionsRoleArn", {
      value: deployRole.roleArn,
    });
  }
}
