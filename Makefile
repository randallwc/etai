PARTS := messaging bus calendar-agent shared models

.PHONY: test $(PARTS) run-messaging run-bus frontend-install frontend-dev frontend-build frontend-test demo

test:
	npm test

$(PARTS):
	$(MAKE) -C $@ test

run-messaging:
	$(MAKE) -C messaging run

run-bus:
	$(MAKE) -C bus run

frontend-install:
	$(MAKE) -C frontend install

frontend-dev:
	$(MAKE) -C frontend dev

frontend-build:
	$(MAKE) -C frontend build

frontend-test:
	$(MAKE) -C frontend test

demo:
	node scripts/demo.js
