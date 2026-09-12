1. comments. no comments in code. only doc strings for functions that are external and well named functions
2. always create a schema before making any code and commit that. under a models directory
3. keep documents in ./docs
4. never over engineer. KISS
5. commits. keep commits as short as possible. one line heading and 2-3 sentences after. keep details in ./docs
6. docs. keep docs written in a unix format. no tables. give prose summaries of each part that is external. document gotchas. document tried approaches and why you didn't do a certain way for others to learn.
7. tests. unit test up to 80% line and 80% branch coverage for every commit. make sure tests run on commit creation with git hooks. do not over test to reach this goal do not split up things to get coverage unless it is valuable. test things more if they are shared.
