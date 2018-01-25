sops --encrypt --gcp-kms projects/mattb-k8s/locations/global/keyRings/sops/cryptoKeys/sops-key secrets.yaml > secrets-sops.yaml
