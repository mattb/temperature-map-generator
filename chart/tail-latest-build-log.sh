gcloud container builds log --stream $(gcloud container builds list --format 'value(id)' | head -1)
