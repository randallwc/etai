PARTS := messaging agent calendar-agent shared models

.PHONY: test $(PARTS) run-messaging run-agent frontend-install frontend-dev frontend-build frontend-test demo

test:
	npm test

$(PARTS):
	$(MAKE) -C $@ test

run-messaging:
	$(MAKE) -C messaging run

run-agent:
	$(MAKE) -C agent run

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
