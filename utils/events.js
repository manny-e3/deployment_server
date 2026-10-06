// Redis pub/sub channels between the worker and the API's Socket.IO server.
//   deploy:<id>:logs          { id, lines: [{ seq, stream, line, at }] }
//   deploy:<id>:status        { id, status, commitSha, exitCode, finishedAt }
//   project:<projectId>:status { projectId, targetId, deploymentId, status }
const { redis } = require('./redis');
const { logger } = require('./logger');

const channels = {
  logs: (id) => `deploy:${id}:logs`,
  status: (id) => `deploy:${id}:status`,
  project: (projectId) => `project:${projectId}:status`,
};

// The Redis key the API sets to ask the worker to stop a deploy.
const cancelKey = (id) => `deploy:${id}:cancel`;

async function publish(channel, payload) {
  try {
    await redis.publish(channel, JSON.stringify(payload));
  } catch (err) {
    logger.warn({ err, channel }, 'publish failed');
  }
}

/** Announces a deployment's status to its own room and its project's room. */
async function publishStatus({ id, status, commitSha = null, exitCode = null, finishedAt = null, projectId, targetId }) {
  await publish(channels.status(id), { id, status, commitSha, exitCode, finishedAt });
  await publish(channels.project(projectId), { projectId, targetId, deploymentId: id, status });
}

module.exports = { channels, cancelKey, publish, publishStatus };
