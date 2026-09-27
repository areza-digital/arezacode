CREATE TABLE `billing_event` (
	`id` varchar(255) PRIMARY KEY,
	`workspace_id` varchar(30) NOT NULL,
	`operation` varchar(255) NOT NULL,
	`time_created` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `workspace_operation` UNIQUE INDEX(`workspace_id`,`operation`)
);
--> statement-breakpoint
ALTER TABLE `payment` ADD `refunded_amount` bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `payment` SET `refunded_amount` = `amount` WHERE `time_refunded` IS NOT NULL;
