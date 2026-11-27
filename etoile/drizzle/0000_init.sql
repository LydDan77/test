CREATE TABLE "arrivals" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"party_id" text NOT NULL,
	"person_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"direction" text NOT NULL,
	"mode" text NOT NULL,
	"booking_id" text,
	"segment_index" integer,
	"carrier" text,
	"number" text,
	"from_label" text,
	"to_place" jsonb,
	"scheduled_at" timestamp with time zone,
	"tz" text,
	"expected_at" timestamp with time zone,
	"source" text DEFAULT 'organizer' NOT NULL,
	"ride_need" text DEFAULT 'unknown' NOT NULL,
	"driver_person_id" text,
	"ride_booking_id" text,
	"bags" integer,
	"status" text DEFAULT 'unknown' NOT NULL,
	"status_at" timestamp with time zone,
	"status_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arrivals_party_direction_unique" UNIQUE("party_id","direction"),
	CONSTRAINT "arrivals_times_have_zone" CHECK (("arrivals"."scheduled_at" is null and "arrivals"."expected_at" is null) or "arrivals"."tz" is not null)
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'needed' NOT NULL,
	"title" text NOT NULL,
	"person_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text,
	"vendor_name" text,
	"confirmation_code" text,
	"price_amount" integer,
	"price_currency" text,
	"paid_by_person_id" text,
	"expense_id" text,
	"starts_at" timestamp with time zone,
	"start_tz" text,
	"ends_at" timestamp with time zone,
	"end_tz" text,
	"act_by" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cancel_by" timestamp with time zone,
	"guest_provided" boolean DEFAULT false NOT NULL,
	"notes" text,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_details_match_kind" CHECK ("bookings"."details"->>'kind' = "bookings"."kind"),
	CONSTRAINT "bookings_price_has_currency" CHECK ("bookings"."price_amount" is null or "bookings"."price_currency" is not null),
	CONSTRAINT "bookings_start_has_zone" CHECK ("bookings"."starts_at" is null or "bookings"."start_tz" is not null),
	CONSTRAINT "bookings_end_has_zone" CHECK ("bookings"."ends_at" is null or "bookings"."end_tz" is not null)
);
--> statement-breakpoint
CREATE TABLE "briefing_states" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"item_key" text NOT NULL,
	"plan_id" text,
	"state" text NOT NULL,
	"bucket" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "briefing_states_user_item_unique" UNIQUE("user_id","item_key")
);
--> statement-breakpoint
CREATE TABLE "clocks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"place" jsonb NOT NULL,
	"label" text,
	"is_home" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"plan_id" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"expires_on" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"date" text NOT NULL,
	"merchant" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"paid_by_person_id" text,
	"payment_method" text DEFAULT 'personal_card' NOT NULL,
	"split" jsonb DEFAULT '{"method":"none","parts":[]}'::jsonb NOT NULL,
	"reimbursable" boolean DEFAULT false NOT NULL,
	"billable" boolean DEFAULT false NOT NULL,
	"project_code" text,
	"attendee_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"booking_id" text,
	"receipt" text DEFAULT 'none' NOT NULL,
	"status" text DEFAULT 'paid' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"provider" text NOT NULL,
	"url" text NOT NULL,
	"link_grade" text NOT NULL,
	"unfilled" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "itinerary_items" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone,
	"start_tz" text NOT NULL,
	"ends_at" timestamp with time zone,
	"end_tz" text,
	"local_date" text NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"place" jsonb,
	"person_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"is_key_moment" boolean DEFAULT false NOT NULL,
	"description" text,
	"link" text,
	"owner" text,
	"room" text,
	"track" text,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"name" text NOT NULL,
	"origin" jsonb,
	"guest_token" text NOT NULL,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parties_guest_token_unique" UNIQUE("guest_token")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"party_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"role" text DEFAULT 'guest' NOT NULL,
	"age_group" text DEFAULT 'adult' NOT NULL,
	"child_age" integer,
	"dietary_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dietary_note" text,
	"access_note" text,
	"can_drive" boolean DEFAULT false NOT NULL,
	"vehicle_seats" integer,
	"lodging_booking_id" text,
	"room" text,
	"team" text,
	"job_title" text,
	"guest_token" text,
	"private_notes" text,
	"rsvp_status" text DEFAULT 'not_invited' NOT NULL,
	"rsvp_at" timestamp with time zone,
	"rsvp_via" text,
	"rsvp_answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"message_to_host" text,
	"needs_host_confirmation" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_guest_token_unique" UNIQUE("guest_token")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"template" text NOT NULL,
	"work_mode" text,
	"title" text NOT NULL,
	"destination" jsonb,
	"origin" jsonb NOT NULL,
	"stops" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"start_date" text,
	"end_date" text,
	"date_status" text DEFAULT 'undecided' NOT NULL,
	"tz" text NOT NULL,
	"expected_people" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"currency" text DEFAULT 'USD' NOT NULL,
	"budget_total" integer,
	"reply_deadline" text,
	"project_code" text,
	"purpose" text,
	"kinds_in_use" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kinds_not_needed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_example" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limits_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"from_person_id" text NOT NULL,
	"to_person_id" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"method" text,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ok" boolean NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_cache_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"access" text DEFAULT 'link' NOT NULL,
	"passcode_hash" text,
	"theme" text NOT NULL,
	"accent" text NOT NULL,
	"color_scheme" text DEFAULT 'auto' NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"host_line" text,
	"announcement" jsonb,
	"replies_open" boolean DEFAULT true NOT NULL,
	"reply_deadline" text,
	"reply_by_party" boolean DEFAULT true NOT NULL,
	"allow_maybe" boolean DEFAULT true NOT NULL,
	"who_is_coming" text DEFAULT 'first_names' NOT NULL,
	"published_at" timestamp with time zone,
	"unpublish_on" text,
	"view_count" integer DEFAULT 0 NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rsvp_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sites_plan_id_unique" UNIQUE("plan_id"),
	CONSTRAINT "sites_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"kind" text DEFAULT 'todo' NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"essential" boolean DEFAULT false NOT NULL,
	"due_date" text,
	"assignee_person_id" text,
	"claimed_by_person_id" text,
	"claimed_by_name" text,
	"quantity" integer,
	"done" boolean DEFAULT false NOT NULL,
	"done_at" timestamp with time zone,
	"source" text DEFAULT 'user' NOT NULL,
	"rule_key" text,
	"booking_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_plan_rule_key_unique" UNIQUE("plan_id","rule_key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"home" jsonb NOT NULL,
	"home_airport_iata" text,
	"time_style" text DEFAULT '12h_with_24h' NOT NULL,
	"military_style" text DEFAULT '1441' NOT NULL,
	"show_24h_everywhere" boolean DEFAULT false NOT NULL,
	"units" text DEFAULT 'imperial' NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"clock_shows_weather" boolean DEFAULT true NOT NULL,
	"example_state" text DEFAULT 'seeded' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "arrivals" ADD CONSTRAINT "arrivals_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arrivals" ADD CONSTRAINT "arrivals_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arrivals" ADD CONSTRAINT "arrivals_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arrivals" ADD CONSTRAINT "arrivals_driver_person_id_people_id_fk" FOREIGN KEY ("driver_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arrivals" ADD CONSTRAINT "arrivals_ride_booking_id_bookings_id_fk" FOREIGN KEY ("ride_booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_paid_by_person_id_people_id_fk" FOREIGN KEY ("paid_by_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefing_states" ADD CONSTRAINT "briefing_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefing_states" ADD CONSTRAINT "briefing_states_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clocks" ADD CONSTRAINT "clocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clocks" ADD CONSTRAINT "clocks_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_paid_by_person_id_people_id_fk" FOREIGN KEY ("paid_by_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itinerary_items" ADD CONSTRAINT "itinerary_items_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_lodging_booking_id_bookings_id_fk" FOREIGN KEY ("lodging_booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_from_person_id_people_id_fk" FOREIGN KEY ("from_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_to_person_id_people_id_fk" FOREIGN KEY ("to_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_person_id_people_id_fk" FOREIGN KEY ("assignee_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_claimed_by_person_id_people_id_fk" FOREIGN KEY ("claimed_by_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "arrivals_plan_id_idx" ON "arrivals" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "bookings_plan_id_idx" ON "bookings" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "bookings_plan_kind_idx" ON "bookings" USING btree ("plan_id","kind");--> statement-breakpoint
CREATE INDEX "clocks_user_id_idx" ON "clocks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "clocks_plan_id_idx" ON "clocks" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clocks_one_home_per_user" ON "clocks" USING btree ("user_id") WHERE "clocks"."is_home";--> statement-breakpoint
CREATE INDEX "expenses_plan_date_idx" ON "expenses" USING btree ("plan_id","date");--> statement-breakpoint
CREATE INDEX "handoffs_booking_id_idx" ON "handoffs" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "handoffs_plan_id_idx" ON "handoffs" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "itinerary_items_plan_date_idx" ON "itinerary_items" USING btree ("plan_id","local_date");--> statement-breakpoint
CREATE INDEX "parties_plan_id_idx" ON "parties" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "people_plan_id_idx" ON "people" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "people_party_id_idx" ON "people" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "plans_owner_id_idx" ON "plans" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "plans_owner_start_idx" ON "plans" USING btree ("owner_id","start_date");--> statement-breakpoint
CREATE INDEX "rate_limits_window_start_idx" ON "rate_limits" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "settlements_plan_id_idx" ON "settlements" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "tasks_plan_id_idx" ON "tasks" USING btree ("plan_id");