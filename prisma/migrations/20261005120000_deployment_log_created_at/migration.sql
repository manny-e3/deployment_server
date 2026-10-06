-- Nightly log retention deletes lines by age.
CREATE INDEX `DeploymentLog_createdAt_idx` ON `DeploymentLog`(`createdAt`);
