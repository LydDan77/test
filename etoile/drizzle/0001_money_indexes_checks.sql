ALTER TABLE "bookings" ALTER COLUMN "price_amount" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "expenses" ALTER COLUMN "amount" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "plans" ALTER COLUMN "budget_total" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "settlements" ALTER COLUMN "amount" SET DATA TYPE bigint;--> statement-breakpoint
CREATE INDEX "arrivals_booking_id_idx" ON "arrivals" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "arrivals_driver_person_id_idx" ON "arrivals" USING btree ("driver_person_id");--> statement-breakpoint
CREATE INDEX "arrivals_ride_booking_id_idx" ON "arrivals" USING btree ("ride_booking_id");--> statement-breakpoint
CREATE INDEX "bookings_paid_by_person_id_idx" ON "bookings" USING btree ("paid_by_person_id");--> statement-breakpoint
CREATE INDEX "bookings_expense_id_idx" ON "bookings" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "briefing_states_plan_id_idx" ON "briefing_states" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "expenses_paid_by_person_id_idx" ON "expenses" USING btree ("paid_by_person_id");--> statement-breakpoint
CREATE INDEX "expenses_booking_id_idx" ON "expenses" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "people_lodging_booking_id_idx" ON "people" USING btree ("lodging_booking_id");--> statement-breakpoint
CREATE INDEX "settlements_from_person_id_idx" ON "settlements" USING btree ("from_person_id");--> statement-breakpoint
CREATE INDEX "settlements_to_person_id_idx" ON "settlements" USING btree ("to_person_id");--> statement-breakpoint
CREATE INDEX "signal_cache_expires_at_idx" ON "signal_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "tasks_assignee_person_id_idx" ON "tasks" USING btree ("assignee_person_id");--> statement-breakpoint
CREATE INDEX "tasks_claimed_by_person_id_idx" ON "tasks" USING btree ("claimed_by_person_id");--> statement-breakpoint
CREATE INDEX "tasks_booking_id_idx" ON "tasks" USING btree ("booking_id");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_plan_id_id_unique" UNIQUE("plan_id","id");--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_plan_id_id_unique" UNIQUE("plan_id","id");--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_plan_id_id_unique" UNIQUE("plan_id","id");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_price_currency_code" CHECK ("bookings"."price_currency" is null or "bookings"."price_currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_currency_code" CHECK ("expenses"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_currency_code" CHECK ("plans"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_currency_code" CHECK ("settlements"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_currency_code" CHECK ("users"."currency" ~ '^[A-Z]{3}$');