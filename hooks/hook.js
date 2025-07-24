const fetch = require('node-fetch');

const dataLayerUrl = process.env.DATA_LAYER_BASE_URL;
const controlHubUrl = process.env.CONTROL_HUB_BASE_URL;

const executionTransactionMap = new Map();

async function createTransaction(body) {
	const url = `${dataLayerUrl}/transactions`;

	const res = await fetch(url, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify(body)
	});

	if (!res.ok) {
		throw new Error(`Failed to create transaction: ${res.status} ${res.statusText}`);
	}

	return await res.json();
}

async function syncOutputToDataLayer(transactionId, body) {
	const url = `${dataLayerUrl}/transactions/${transactionId}/workflow-step`;

	await fetch(url, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify(body)
	});

	return {
		executionId: transactionId,
		test: "1234"
	};
}

async function triggerControlHubRules(transactionId) {
	const url = `${controlHubUrl}/transactions/business-rules-execution/all-rules/for-transaction/${transactionId}`;

	await fetch(url, { method: 'POST' });
}

async function getDataLayerContext(transactionId) {
	const url = `${dataLayerUrl}/transactions/${transactionId}/rule-execution-context`;

	const res = await fetch(url, {
		method: 'GET',
		headers: {'Content-Type': 'application/json'}
	});

	if (!res.ok) {
		throw new Error(`Failed to get data layer context: ${res.status} ${res.statusText}`);
	}
	return res.json();
}

function getFlattenedOutput(node) {
	return 'output' in node.json ? node.json.output : node.json;
}

async function getBusinessAppId(workflowId) {
	if (process.env.OVERRIDE_BUSINESS_APP_ID) {
		return process.env.OVERRIDE_BUSINESS_APP_ID;
	}
	const dbWorkflow = await this.dbCollections.Workflow.findById(workflowId);

	const workflowOwner = dbWorkflow.shared.find(sharedData => sharedData.role === 'workflow:owner');

	return workflowOwner?.project.name;
}

async function getWorkspaceId(businessAppId) {
	if (process.env.OVERRIDE_WORKSPACE_ID) {
		return process.env.OVERRIDE_WORKSPACE_ID;
	}
	return 'default-workspace-id'; // Replace with actual logic to get workspace ID
}

async function overrideOutput(transactionId, itemData) {
	const { id, context, ruleDecisions, documents } = await getDataLayerContext(transactionId);
	itemData.forEach(element => {
		const oldValue = getFlattenedOutput(element);
		element.json = {
			output: oldValue,
			data: {
				id,
				context,
				ruleDecisions,
				documents
			}
		}
	});
}

module.exports = {
	"workflow": {
		"preExecute": [
			async function (workflow, _, executionId) {
				const workflowId = workflow.id;

				const businessAppId = await getBusinessAppId(workflowId);
				const workspaceId = await getWorkspaceId(businessAppId);

				const nodeInfos = Object.entries(workflow.nodes ?? {}).map(([key, value]) => ({name: key, id: value.id}));

				const transaction = await createTransaction({
					businessAppId,
					workspaceId,
					workflowData: {
						executionId,
						workflowConfiguration: {
							workflowId,
							nodeInfos
						}
					}
				});

				executionTransactionMap.set(executionId, transaction.id);
			}
		],
		"postExecute": [
			async function (_, __, executionId) {
				executionTransactionMap.delete(executionId)
			}
		]
	},
	"node": {
		"postExecute": [
			async function (nodeName, taskData, executionData) {
				if (!taskData.data) {
					return;
				}

				const itemData = taskData.data.main[0];

				const output = itemData.map(getFlattenedOutput);
				const executionId = executionData.executionId;

				const transactionId = executionTransactionMap.get(executionId.toString());

				if (!transactionId) {
					throw new Error(`No transaction found for execution ID: ${executionId}`);
				}

				await syncOutputToDataLayer(transactionId, {
					nodeName,
					output
				});

				await triggerControlHubRules(transactionId);
				await overrideOutput(transactionId, itemData);
			}
		],
	}
}
