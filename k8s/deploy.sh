sops --decrypt secrets-sops.yaml | kubectl apply -f -
kubectl apply -f deployment.yaml
kubectl apply -f service-water.yaml
