# Vale Linting for Sitecore Docs

This repository contains a `.vale.ini` configuration file and a `.vale` folder with custom styles for linting documentation using [Vale](https://vale.sh/).

## Prerequisites

- [Vale](https://vale.sh/) must be installed on your system.

## Installation

Refer their docs to [install Vale](https://vale.sh/docs/install) on your operating system.

Confirm installation by running the following command from the command line:

```bash
vale --version
```

## Configuration

1. Clone this repository or copy the `.vale.ini` and `.vale/` folder into your documentation project.

1. Ensure your `.vale.ini` file references the correct styles path.

1. You can customise the `.vale.ini` file to enable or disable specific styles.

## Usage

Vale automatically lints documentation in the same folder as the `.vale` and `.vale.ini` files, but you can also use it from the command line to target specific files or folders:

```bash
# Specific file
vale path/to/file.md

# Entire folder
vale docs/
```