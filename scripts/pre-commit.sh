#!/bin/sh
npm --prefix frontend test -- --coverage.enabled=false || exit 1
