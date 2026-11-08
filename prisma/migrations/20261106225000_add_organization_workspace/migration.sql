-- CreateTable
CREATE TABLE `Organization` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Organization_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `User` ADD COLUMN `organizationId` VARCHAR(191) NULL;
ALTER TABLE `Server` ADD COLUMN `organizationId` VARCHAR(191) NULL;
ALTER TABLE `Project` ADD COLUMN `organizationId` VARCHAR(191) NULL;

-- Create default primary organization
INSERT INTO `Organization` (`id`, `name`, `createdAt`, `updatedAt`)
VALUES ('org_primary_default', 'Primary Workspace', NOW(3), NOW(3));

-- Backfill existing servers and projects to the primary organization
UPDATE `Server` SET `organizationId` = 'org_primary_default' WHERE `organizationId` IS NULL;
UPDATE `Project` SET `organizationId` = 'org_primary_default' WHERE `organizationId` IS NULL;

-- Backfill initial users
UPDATE `User` SET `organizationId` = 'org_primary_default' WHERE `organizationId` IS NULL;

-- If Emmanuel (new user) exists, isolate his account into his own organization 'emmanuel'
INSERT IGNORE INTO `Organization` (`id`, `name`, `createdAt`, `updatedAt`)
VALUES ('org_emmanuel', 'emmanuel', NOW(3), NOW(3));

UPDATE `User` SET `organizationId` = 'org_emmanuel' WHERE `email` = 'aboajah.e.mmanuel@gmail.com';

-- Create Indexes
CREATE INDEX `User_organizationId_idx` ON `User`(`organizationId`);
CREATE INDEX `Server_organizationId_idx` ON `Server`(`organizationId`);
CREATE INDEX `Project_organizationId_idx` ON `Project`(`organizationId`);

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Server` ADD CONSTRAINT `Server_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

