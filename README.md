# CommitGuard - Enterprise Pre-Commit Setup

Automatically sets up pre-commit hooks for enterprise code quality and security standards.

## Features

- 🚀 **Zero Configuration**: Automatically installs and configures pre-commit hooks
- 🔒 **Security First**: Includes Gitleaks for secret detection
- 🎯 **Enterprise Ready**: Pre-configured with industry-standard checks
- 🔄 **Multi-Workspace**: Supports multiple workspace folders
- 🪟 **Cross-Platform**: Works on Windows, macOS, and Linux

## What It Does

When you open a Git repository, CommitGuard automatically:
1. Installs the pre-commit tool (if not already installed)
2. Creates a `.pre-commit-config.yaml` with enterprise standards
3. Installs Git hooks to run checks before every commit

## Requirements

- Python 3.7+ (for pre-commit installation)
- Git repository

## Extension Settings

- `commitGuard.autoSetupOnStartup`: Enable/disable automatic setup (default: true)
- `commitGuard.precommitConfig`: Custom pre-commit configuration (optional)
- `commitGuard.showTerminalOnInstall`: Show terminal during installation (default: true)

## Manual Setup

Run from Command Palette (Ctrl+Shift+P):