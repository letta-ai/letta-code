{ self }:
{ config, lib, pkgs, ... }:
let
  cfg = config.programs.letta-code;
in
{
  options.programs.letta-code = {
    enable = lib.mkEnableOption "Letta Code CLI";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.letta-code.packages.\${pkgs.stdenv.hostPlatform.system}.default";
      description = "Letta Code package to install.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
