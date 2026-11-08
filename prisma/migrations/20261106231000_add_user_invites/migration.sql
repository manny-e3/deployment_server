-- AlterTable
ALTER TABLE `User` ADD COLUMN `roleTitle` VARCHAR(191) NULL,
    ADD COLUMN `inviteToken` VARCHAR(191) NULL,
    ADD COLUMN `invitedAt` DATETIME(3) NULL,
    ADD COLUMN `inviteAcceptedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `User_inviteToken_key` ON `User`(`inviteToken`);

