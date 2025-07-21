const fetch = require('node-fetch');

const dataLayerUrl = process.env.DATA_LAYER_BASE_URL;
const controlHubUrl = process.env.CONTROL_HUB_BASE_URL;

async function createTransaction(body) {
	const url = `${dataLayerUrl}/transactions`;
	console.log(`FETCH ${url}\n`, body);

	await fetch(url, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify(body)
	});
}

async function syncOutputToDataLayer(executionId, body) {
	const url = `${dataLayerUrl}/transactions/executions/${executionId}/workflow-steps`;
	console.log(`FETCH ${url}\n`, body);

	await fetch(url, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify(body)
	});

	return {
		executionId,
		test: "1234"
	};
}

async function triggerControlHubRules(executionId) {
	const url = `${controlHubUrl}/transactions/business-rules-execution/all-rules/for-execution/${executionId}`;

	console.log(`FETCH ${url}`);

	// await fetch(url, { method: 'POST' });
}

function getFlattenedOutput(node) {
	return 'output' in node.json ? node.json.output : node.json;
}

module.exports = {
	"workflow": {
		"preExecute": [
			async function (workflow, _, executionId) {
				const dbWorkflow = await this.dbCollections.Workflow.findById(workflow.id);

				const workflowOwner = dbWorkflow.shared.find(sharedData => sharedData.role === 'workflow:owner');

				const businessAppId = workflowOwner?.project.name;

				const workflowId = workflow.id;
				const nodeInfos = Object.entries(workflow.nodes ?? {}).map(([key, value]) => ({name: key, id: value.id}));

				await createTransaction({
					businessAppId,
					executionId,
					workflowConfiguration: {
						workflowId,
						nodeInfos
					}
				});
			}
		],
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

				const dataLayerValue = await syncOutputToDataLayer(executionId, {
					nodeName,
					output
				});

				await triggerControlHubRules(executionId);

				itemData.forEach(element => {
					const oldValue = getFlattenedOutput(element);
					element.json = {
						output: oldValue,
						data: {
							...dataLayerValue,
							nodeName
						}
					}
				});
			}
		],
	}
}
