{ self }:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.letta-code;
in
{
  options.services.letta-code = {
    enable = lib.mkEnableOption "Letta Code listener service";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.letta-code.packages.\${pkgs.stdenv.hostPlatform.system}.default";
      description = "Letta Code package to run.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "letta-code";
      description = "User account that runs the Letta Code service.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "letta-code";
      description = "Group account that runs the Letta Code service.";
    };

    workingDirectory = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/letta-code";
      description = "Working directory used by the service.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/letta-code.env";
      description = "Optional systemd EnvironmentFile containing LETTA_API_KEY, provider keys, or channel tokens.";
    };

    extraArgs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "listen" ];
      example = [ "--backend" "local" "listen" ];
      description = "Arguments passed to the letta CLI.";
    };

    extraEnvironment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Additional environment variables for the service.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups.${cfg.group} = { };
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      home = cfg.workingDirectory;
      createHome = true;
    };

    systemd.services.letta-code = {
      description = "Letta Code listener";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      environment = cfg.extraEnvironment;
      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = cfg.workingDirectory;
        StateDirectory = "letta-code";
        ExecStart = lib.escapeShellArgs ([ "${cfg.package}/bin/letta" ] ++ cfg.extraArgs);
        Restart = "on-failure";
        RestartSec = "5s";
      } // lib.optionalAttrs (cfg.environmentFile != null) {
        EnvironmentFile = cfg.environmentFile;
      };
    };
  };
}
