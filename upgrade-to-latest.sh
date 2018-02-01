helm upgrade temperature-map chart/ --namespace apps --set image.tag=$(git rev-list --max-count 1 HEAD)
