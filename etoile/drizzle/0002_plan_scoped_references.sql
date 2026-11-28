ALTER TABLE "arrivals" DROP CONSTRAINT "arrivals_party_id_parties_id_fk";
--> statement-breakpoint
ALTER TABLE "handoffs" DROP CONSTRAINT "handoffs_booking_id_bookings_id_fk";
--> statement-breakpoint
ALTER TABLE "people" DROP CONSTRAINT "people_party_id_parties_id_fk";
--> statement-breakpoint
ALTER TABLE "settlements" DROP CONSTRAINT "settlements_from_person_id_people_id_fk";
--> statement-breakpoint
ALTER TABLE "settlements" DROP CONSTRAINT "settlements_to_person_id_people_id_fk";
--> statement-breakpoint
ALTER TABLE "arrivals" ADD CONSTRAINT "arrivals_plan_party_fk" FOREIGN KEY ("plan_id","party_id") REFERENCES "public"."parties"("plan_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_plan_booking_fk" FOREIGN KEY ("plan_id","booking_id") REFERENCES "public"."bookings"("plan_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_plan_party_fk" FOREIGN KEY ("plan_id","party_id") REFERENCES "public"."parties"("plan_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_plan_from_person_fk" FOREIGN KEY ("plan_id","from_person_id") REFERENCES "public"."people"("plan_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_plan_to_person_fk" FOREIGN KEY ("plan_id","to_person_id") REFERENCES "public"."people"("plan_id","id") ON DELETE no action ON UPDATE no action;