# Dummy Dev Repository

This is a template and sample configuration for your development application repository.

## How It Works

Whenever code is committed and pushed to this dev repository (e.g. `main` or `dev`), its GitHub Actions workflow automatically dispatches a webhook event to **[SolomonJesurathinam/TestAxeCore](https://github.com/SolomonJesurathinam/TestAxeCore)** to run the accessibility test suite and generate HTML & CSV reports!

### Setup in 2 Easy Steps:

1. **Create a GitHub Personal Access Token (PAT):**
   * Go to GitHub **Settings** -> **Developer settings** -> **Personal access tokens** (Tokens classic).
   * Generate a token with the `repo` scope.
2. **Add Secret in this Dev Repo:**
   * Go to this repository's **Settings** -> **Secrets and variables** -> **Actions**.
   * Add a repository secret named:
     `GH_PAT_FOR_TEST_REPO`
   * Paste your PAT value.

Now, whenever you commit to this repo, **TestAxeCore** will automatically run tests and generate reports!
