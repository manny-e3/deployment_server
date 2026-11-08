-- AlterTable Server
ALTER TABLE `Server` 
  ADD COLUMN `publicKey` TEXT NULL,
  ADD COLUMN `setupToken` VARCHAR(191) NULL UNIQUE,
  ADD COLUMN `setupCompletedAt` DATETIME(3) NULL;

